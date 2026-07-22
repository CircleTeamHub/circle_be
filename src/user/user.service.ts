import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { UserErrorCode } from 'src/common/app-error-codes';
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
import { likedOnToday } from '../like/like.util';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logBusinessEvent } from 'src/logging/business-event.logger';
import {
  generateUniqueRegistrationCode,
  isInviteCodeUniqueCollision,
  REGISTRATION_CODE_MAX_ATTEMPTS,
} from 'src/auth/account-id.unique';

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

type ProfilePrivacyUser = {
  id: string;
  phoneNumber?: string | null;
  wechat?: string | null;
  qq?: string | null;
  whatsup?: string | null;
};

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
  private readonly loggingConfig = createLoggingConfig();
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
  ) {
    this.minioPublicUrl = this.config.get<string>('MINIO_PUBLIC_URL') ?? null;
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

    return { data, total, page, limit: take };
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
    return user ? this.applyProfilePrivacy(user, viewerId) : null;
  }

  async findOne(id: string, viewerId?: string) {
    const [user, displayIcons] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id },
        select: PUBLIC_SELECT,
      }),
      this.iconService.getDisplayIconsForUser(id),
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
      ...filteredUser,
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
    const passwordHash = await argon2.hash(input.password);
    for (
      let attempt = 0;
      attempt < REGISTRATION_CODE_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const inviteCode = await generateUniqueRegistrationCode(this.prisma);
      try {
        return await this.prisma.user.create({
          data: {
            accountId: input.accountId,
            inviteCode,
            passwordHash,
            nickname: input.nickname || input.accountId,
          },
          select: PUBLIC_SELECT,
        });
      } catch (error) {
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
    const displayIcons = await this.iconService.getDisplayIconsForUser(id);
    await this.realtimeService.invalidateUserProfileSummaryCache(id);
    await this.realtimeService.broadcastUserProfileSummary(id);

    return {
      ...user,
      displayIcons,
    };
  }

  async remove(id: string) {
    await this.findOne(id);
    const [user, displayIcons] = await Promise.all([
      this.prisma.user.update({
        where: { id },
        data: { status: UserStatus.DELETED },
        select: PUBLIC_SELECT,
      }),
      this.iconService.getDisplayIconsForUser(id),
    ]);
    // A deleted user must lose every active session; otherwise an attacker
    // (or the user themselves) can keep refreshing tokens for up to 7 days.
    await this.refreshTokens.revokeAll(id);
    return {
      ...user,
      displayIcons,
    };
  }

  async updateStatus(
    id: string,
    status: UserStatus,
    options: { actorId?: string; reason?: string } = {},
  ) {
    const current = await this.findOne(id);
    const [user, displayIcons] = await Promise.all([
      this.prisma.user.update({
        where: { id },
        data: { status },
        select: PUBLIC_SELECT,
      }),
      this.iconService.getDisplayIconsForUser(id),
    ]);
    // BAN / DELETE must invalidate sessions immediately. ACTIVE → ACTIVE is a
    // no-op revoke call; cheaper than introducing a branch.
    if (status !== UserStatus.ACTIVE) {
      await this.refreshTokens.revokeAll(id);
    }
    await this.realtimeService.invalidateUserProfileSummaryCache(id);
    await this.realtimeService.broadcastUserProfileSummary(id);
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'admin_user_status_changed',
      actorId: options.actorId,
      targetId: id,
      result: 'success',
      entityType: 'user',
      entityId: id,
      metadata: {
        oldStatus: current.status,
        newStatus: status,
        reason: options.reason,
      },
    });
    return {
      ...user,
      displayIcons,
    };
  }

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
