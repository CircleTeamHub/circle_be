import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuthErrorCode, UserErrorCode } from 'src/common/app-error-codes';
import * as argon2 from 'argon2';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { RefreshTokenService } from 'src/auth/refresh-token.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { assertUrlsFromStorage } from 'src/utils/storage-url';
import { GetUserDto } from './dto/get-user.dto';
import { Gender, UserStatus } from 'src/generated/prisma';
import { IconService } from 'src/icon/icon.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { USER_PROFILE_SELECT } from './user.select';
import { OpenimService } from 'src/openim/openim.service';
import { likedOnToday } from '../like/like.util';
import {
  generateUniqueRegistrationCode,
  isInviteCodeUniqueCollision,
  REGISTRATION_CODE_MAX_ATTEMPTS,
} from 'src/auth/account-id.unique';
import {
  resolveMembershipAppearance,
  toPublicMembershipAppearance,
} from 'src/membership/membership-appearance';
import { resolveEffectiveMembershipLevel } from 'src/membership/membership.catalog';
import {
  AvatarFramePublicAppearance,
  AvatarFrameService,
  PublicUserAppearance,
} from 'src/avatar-frame/avatar-frame.service';

const URL_FIELDS: (keyof UpdateUserInput)[] = [
  'avatarUrl',
  'avatarFrame',
  'cover',
];

export interface CreateUserInput {
  accountId: string;
  password: string;
  nickname?: string;
}

export interface UpdateUserInput {
  nickname?: string;
  avatarUrl?: string;
  avatarFrame?: string;
  cover?: string;
  email?: string;
  phoneNumber?: string;
  wechat?: string;
  qq?: string;
  whatsup?: string;
  persona?: string;
  helloWords?: string;
  birthday?: string | null;
  gender?: Gender;
  city?: string | null;
  region?: string | null;
}

const PUBLIC_SELECT = USER_PROFILE_SELECT;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ProfilePrivacyUser = {
  id: string;
  phoneNumber?: string | null;
  wechat?: string | null;
  qq?: string | null;
  whatsup?: string | null;
};

type ProfileMembershipUser = {
  vipLevel?: number;
  vipExpiresAt?: Date | null;
};

function toPublicUser<T extends ProfileMembershipUser>(
  user: T,
  avatarFrameAppearance: AvatarFramePublicAppearance | null = null,
) {
  const { vipLevel = 0, vipExpiresAt = null, ...profile } = user;
  const membership = toPublicMembershipAppearance({ vipLevel, vipExpiresAt });
  return {
    ...profile,
    vipLevel: membership.effectiveLevel,
    membership,
    avatarFrameAppearance,
  };
}

// 自视图映射：保留 storedVipLevel / vipExpiresAt 与含 active·lifetime 的完整 appearance，
// 供序列化成 SelfUserDto 的路径（如 PATCH /user/:id）用。toPublicUser 是「无 PII」的他人
// 视图、会剥掉这些自有字段；PATCH 若用它，SelfUserDto 的新契约字段就会全部缺失（与
// /auth/me 不一致）。
function toSelfUser<T extends ProfileMembershipUser>(
  user: T,
  avatarFrameAppearance: AvatarFramePublicAppearance | null = null,
  now = new Date(),
) {
  const { vipLevel = 0, vipExpiresAt = null, ...profile } = user;
  const membership = resolveMembershipAppearance(
    { vipLevel, vipExpiresAt },
    now,
  );
  return {
    ...profile,
    storedVipLevel: vipLevel,
    vipExpiresAt,
    vipLevel: membership.effectiveLevel,
    membership,
    avatarFrameAppearance,
  };
}

function normalizeBirthdayInput(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const normalized = value.trim();

  if (!normalized) {
    return null;
  }

  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? new Date(`${normalized}T00:00:00.000Z`)
    : new Date(normalized);

  if (Number.isNaN(parsed.getTime())) {
    // The DTO's @IsDateString validator should already reject this, but the
    // service is also called from places that bypass the pipe (e.g. internal
    // jobs); fail fast instead of letting an Invalid Date hit Prisma.
    throw new BadRequestException({
      message: `Invalid birthday value: ${value}`,
      errorCode: UserErrorCode.InvalidBirthday,
    });
  }

  return parsed;
}

// Optional text fields where a blank (empty / whitespace-only) value means
// "clear it" — persisted as null instead of an empty string. Excludes required
// fields (nickname) and format-validated fields (email, avatar URLs), which the
// DTO layer rejects when blank so they never reach here empty.
const BLANKABLE_TEXT_FIELDS: ReadonlySet<keyof UpdateUserInput> = new Set([
  'phoneNumber',
  'wechat',
  'qq',
  'whatsup',
  'persona',
  'helloWords',
  'city',
  'region',
]);

function normalizeUpdateInput(input: UpdateUserInput) {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    // birthday gets dedicated date normalization below; non-strings pass through.
    if (key === 'birthday' || typeof value !== 'string') {
      result[key] = value;
      continue;
    }

    const trimmed = value.trim();
    result[key] =
      trimmed === '' && BLANKABLE_TEXT_FIELDS.has(key as keyof UpdateUserInput)
        ? null
        : trimmed;
  }

  if ('birthday' in input) {
    result.birthday = normalizeBirthdayInput(input.birthday);
  }

  return result as UpdateUserInput;
}

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  private readonly minioPublicUrl: string | null;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private refreshTokens: RefreshTokenService,
    private iconService: IconService,
    private realtimeService: RealtimeService,
    // Required dependency: profile privacy must fail closed. A missing provider
    // is a wiring bug that should crash at startup, not silently expose
    // phone/wechat/qq. PrivacySettingsModule is imported by UserModule.
    private privacySettings: PrivacySettingsService,
    private avatarFrames: AvatarFrameService,
  ) {
    this.minioPublicUrl = this.config.get<string>('MINIO_PUBLIC_URL') ?? null;
  }

  /**
   * 批量取 userId → vipLevel（前端渲染会员名字特效用）。vipLevel 是公开展示属性，
   * 任意登录用户可查；不存在的 id 不会出现在结果里，前端按缺省 0 处理。
   */
  async getVipLevels(ids: string[]): Promise<Record<string, number>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return {};
    }
    // 客户端可能传标准 UUID(REST 场景)或无连字符的 OpenIM sendID(聊天场景)。两者都归一到
    // UUID 去查 User.id,但响应仍以**调用方传入的原始 id** 为键——前端好按它当初传的原样查回。
    // 同一批里可能同时传了一个用户的 UUID 和无连字符形态(两种 UI 各用一种),它们归一到同一
    // 个 id;必须记录每个归一化 id 的**所有**别名并逐个产出,否则用另一形态的一侧会把已知
    // 用户默认成 VIP0。
    const aliasesByNormalized = new Map<string, string[]>();
    for (const id of uniqueIds) {
      const normalized = OpenimService.fromImUserId(id);
      const list = aliasesByNormalized.get(normalized);
      if (list) {
        list.push(id);
      } else {
        aliasesByNormalized.set(normalized, [id]);
      }
    }
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...aliasesByNormalized.keys()] } },
      select: { id: true, vipLevel: true, vipExpiresAt: true },
    });
    // Resolve expiry so an expired level 1–3 stops driving paid name effects on
    // the chat surfaces that consume this map; this mirrors every other public
    // profile path instead of leaking the stored (unexpired) level.
    const now = new Date();
    const out: Record<string, number> = {};
    for (const user of users) {
      const effectiveLevel = resolveEffectiveMembershipLevel(user, now);
      for (const alias of aliasesByNormalized.get(user.id) ?? [user.id]) {
        out[alias] = effectiveLevel;
      }
    }
    return out;
  }

  async getAppearances(
    ids: string[],
  ): Promise<Record<string, PublicUserAppearance>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return {};
    }

    const aliasesByNormalized = new Map<string, string[]>();
    for (const id of uniqueIds) {
      const normalized = OpenimService.fromImUserId(id).toLowerCase();
      if (!UUID_PATTERN.test(normalized)) {
        continue;
      }
      const aliases = aliasesByNormalized.get(normalized);
      if (aliases) {
        aliases.push(id);
      } else {
        aliasesByNormalized.set(normalized, [id]);
      }
    }

    const appearances = await this.avatarFrames.resolvePublicAppearances([
      ...aliasesByNormalized.keys(),
    ]);
    const result: Record<string, PublicUserAppearance> = {};
    for (const [normalizedId, appearance] of appearances) {
      for (const alias of aliasesByNormalized.get(normalizedId) ?? []) {
        result[alias] = appearance;
      }
    }
    return result;
  }

  /**
   * Rejects URL fields that don't originate from our own storage.
   * Prevents SSRF-capable URLs (cloud metadata, localhost, javascript:, data:)
   * being stored and later rendered by clients.
   *
   * Delegates to the shared `assertUrlsFromStorage` guard — which closes the
   * `host.attacker.com` bypass that the previous bare `startsWith` allowed.
   */
  private assertUrlsAreSafe(input: UpdateUserInput): void {
    assertUrlsFromStorage(
      URL_FIELDS.map((field) => input[field] as string | undefined),
      this.minioPublicUrl,
      'profile image url',
    );
  }

  async findAll(query: GetUserDto) {
    const { limit = 10, page = 1, accountId, status } = query;
    const take = limit;
    const skip = (page - 1) * take;
    const where =
      accountId || status
        ? {
            ...(accountId ? { accountId: { contains: accountId } } : {}),
            ...(status ? { status } : {}),
          }
        : undefined;

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({ where, select: PUBLIC_SELECT, take, skip }),
      this.prisma.user.count({ where }),
    ]);

    const appearances = await this.avatarFrames.resolvePublicAppearances(
      data.map((user) => user.id),
    );
    return {
      data: data.map((user) =>
        toPublicUser(user, appearances.get(user.id)?.avatarFrame ?? null),
      ),
      total,
      page,
      limit: take,
    };
  }

  async findByExactAccountId(accountId: string | undefined, viewerId?: string) {
    if (!accountId) return null;
    const normalized = accountId.trim();

    if (!normalized) {
      return null;
    }

    const user = await this.prisma.user.findFirst({
      where: {
        accountId: {
          equals: normalized,
          mode: 'insensitive',
        },
        status: 'ACTIVE',
      },
      select: PUBLIC_SELECT,
    });

    // Apply the same field-privacy gate as GET /user/:id. Without it the
    // friend-add lookup leaks wechat/qq that the target set to private (F-01).
    if (!user) {
      return null;
    }
    const [filteredUser, appearances] = await Promise.all([
      this.applyProfilePrivacy(user, viewerId),
      this.avatarFrames.resolvePublicAppearances([user.id]),
    ]);
    return toPublicUser(
      filteredUser,
      appearances.get(user.id)?.avatarFrame ?? null,
    );
  }

  async findOne(id: string, viewerId?: string) {
    const [user, displayIcons, appearances] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id },
        select: PUBLIC_SELECT,
      }),
      this.iconService.getDisplayIconsForUser(id),
      this.avatarFrames.resolvePublicAppearances([id]),
    ]);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    const filteredUser = await this.applyProfilePrivacy(user, viewerId);
    // 资料页携带「被赞总数 + 我今天赞过没」（看自己时 likedByMeToday 恒为 false）。
    const likedByMeToday =
      viewerId && viewerId !== id
        ? Boolean(
            await this.prisma.userLike.findUnique({
              where: {
                fromUserID_toUserID_likedOn: {
                  fromUserID: viewerId,
                  toUserID: id,
                  likedOn: likedOnToday(),
                },
              },
            }),
          )
        : false;
    return {
      ...toPublicUser(filteredUser, appearances.get(id)?.avatarFrame ?? null),
      displayIcons,
      likeCount: user.receivedLikeCount,
      likedByMeToday,
    };
  }

  private async applyProfilePrivacy<T extends ProfilePrivacyUser>(
    user: T,
    viewerId?: string,
  ): Promise<T> {
    const isSelf = viewerId === user.id;
    // isFriend is intentionally hardcoded to false here: phone/wechat/qq
    // visibility is a global show/hide switch in the current model, not
    // friend-aware. If a "friends-only" profile tier is ever added, thread the
    // real friendship status through instead of this literal.
    const [canViewPhone, canViewWechat, canViewQQ, canViewWhatsup] =
      await Promise.all([
        this.privacySettings.canViewProfileField(
          user.id,
          'phoneNumber',
          isSelf,
          false,
        ),
        this.privacySettings.canViewProfileField(
          user.id,
          'wechat',
          isSelf,
          false,
        ),
        this.privacySettings.canViewProfileField(user.id, 'qq', isSelf, false),
        this.privacySettings.canViewProfileField(
          user.id,
          'whatsup',
          isSelf,
          false,
        ),
      ]);

    return {
      ...user,
      phoneNumber: canViewPhone ? user.phoneNumber : null,
      wechat: canViewWechat ? user.wechat : null,
      qq: canViewQQ ? user.qq : null,
      whatsup: canViewWhatsup ? user.whatsup : null,
    };
  }

  async create(input: CreateUserInput) {
    const normalizedAccountId = input.accountId.trim().toLowerCase();
    const identifierClaim = await this.prisma.accountIdentifier.findUnique({
      where: { value: normalizedAccountId },
      select: {
        currentUserID: true,
        reservedForUserID: true,
        inviteOwnerUserID: true,
        fancyNumber: { select: { id: true } },
      },
    });
    if (
      identifierClaim &&
      (identifierClaim.currentUserID !== null ||
        identifierClaim.reservedForUserID !== null ||
        identifierClaim.inviteOwnerUserID !== null ||
        identifierClaim.fancyNumber !== null)
    ) {
      throw this.accountIdTaken();
    }

    const passwordHash = await argon2.hash(input.password);
    for (
      let attempt = 0;
      attempt < REGISTRATION_CODE_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const inviteCode = await generateUniqueRegistrationCode(this.prisma);
      try {
        const user = await this.prisma.user.create({
          data: {
            accountId: input.accountId,
            inviteCode,
            passwordHash,
            nickname: input.nickname || input.accountId,
          },
          select: PUBLIC_SELECT,
        });
        const appearances = await this.avatarFrames.resolvePublicAppearances([
          user.id,
        ]);
        return toPublicUser(
          user,
          appearances.get(user.id)?.avatarFrame ?? null,
        );
      } catch (error) {
        if (this.isAccountIdentifierCollision(error, normalizedAccountId)) {
          throw this.accountIdTaken();
        }
        if (this.isAccountIdentifierCollision(error, inviteCode)) {
          if (attempt < REGISTRATION_CODE_MAX_ATTEMPTS - 1) continue;
          break;
        }
        if (isInviteCodeUniqueCollision(error)) {
          if (attempt < REGISTRATION_CODE_MAX_ATTEMPTS - 1) continue;
          break;
        }
        throw error;
      }
    }

    throw new ServiceUnavailableException(
      'Failed to create a user with a unique invite code',
    );
  }

  private accountIdTaken() {
    return new ConflictException({
      message: '该账号已被占用',
      errorCode: AuthErrorCode.AccountIdTaken,
    });
  }

  private isAccountIdentifierCollision(error: unknown, value: string): boolean {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String(error.message)
          : String(error);
    return message
      .toLowerCase()
      .includes(`account identifier collision: ${value.toLowerCase()}`);
  }

  async update(id: string, input: UpdateUserInput) {
    this.assertUrlsAreSafe(input);
    await this.findOne(id);
    const normalizedInput = normalizeUpdateInput(input);
    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: normalizedInput,
        select: PUBLIC_SELECT,
      });
      if (input.nickname !== undefined || input.avatarUrl !== undefined) {
        await tx.userProfileSyncOutbox.upsert({
          where: { userID: id },
          create: { userID: id, generation: 1 },
          update: {
            status: 'PENDING',
            generation: { increment: 1 },
            attempts: 0,
            lastError: null,
            nextAttemptAt: new Date(),
            processedAt: null,
          },
        });
      }
      return updated;
    });
    const [displayIcons, appearances] = await Promise.all([
      this.iconService.getDisplayIconsForUser(id),
      this.avatarFrames.resolvePublicAppearances([id]),
    ]);
    await this.realtimeService.invalidateUserProfileSummaryCache(id);
    await this.realtimeService.broadcastUserProfileSummary(id);

    return {
      ...toSelfUser(user, appearances.get(id)?.avatarFrame ?? null),
      displayIcons,
    };
  }

  async remove(id: string) {
    await this.findOne(id);
    const [user, displayIcons, appearances] = await Promise.all([
      this.prisma.user.update({
        where: { id },
        data: { status: UserStatus.DELETED },
        select: PUBLIC_SELECT,
      }),
      this.iconService.getDisplayIconsForUser(id),
      this.avatarFrames.resolvePublicAppearances([id]),
    ]);
    // A deleted user must lose every active session; otherwise an attacker
    // (or the user themselves) can keep refreshing tokens for up to 7 days.
    await this.refreshTokens.revokeAll(id);
    // Map through toPublicUser like every other public-user response: resolve
    // the effective (expiry-aware) vipLevel and attach the membership object,
    // so an expired paid tier can't leak its stored level in the deletion body.
    return {
      ...toPublicUser(user, appearances.get(id)?.avatarFrame ?? null),
      displayIcons,
    };
  }

  // updateStatus 已移除：管理端状态变更统一走 AdminUserService（#121），那里带
  // 事务、状态机校验、删除确认和 AdminAuditLog 留痕，这里的无审计版本是后门。

  async updateBasicProfile(id: string, input: UpdateUserInput) {
    // Same storage-origin guard as `update` — an off-origin avatarUrl/cover
    // would otherwise become a stored tracking / phishing vector.
    this.assertUrlsAreSafe(input);
    const user = await this.prisma.user.update({
      where: { id },
      data: normalizeUpdateInput(input),
      select: PUBLIC_SELECT,
    });
    await this.realtimeService.invalidateUserProfileSummaryCache(id);
    await this.realtimeService.broadcastUserProfileSummary(id);
    return user;
  }
}
