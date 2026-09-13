import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ChatErrorCode, UserErrorCode } from 'src/common/app-error-codes';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { normalizeUserIdAlias } from './user-id-alias';
import { RefreshTokenService } from 'src/auth/refresh-token.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import {
  assertUrlsFromStorage,
  storagePublicObjectBasesFromConfig,
} from 'src/utils/storage-url';
import { Gender, UserStatus } from 'src/generated/prisma';
import { IconService } from 'src/icon/icon.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { USER_ME_SELECT, USER_PROFILE_SELECT } from './user.select';
import { resolveEffectiveMembershipLevel } from 'src/membership/membership.catalog';
import {
  AvatarFramePublicAppearance,
  AvatarFrameService,
  PublicUserAppearance,
} from 'src/avatar-frame/avatar-frame.service';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logBusinessEvent } from 'src/logging/business-event.logger';
import { isBlockedByStandaloneGroupPolicy } from 'src/chat/standalone-group-policy-gate';

const URL_FIELDS: (keyof UpdateUserInput)[] = [
  'avatarUrl',
  'avatarFrame',
  'cover',
];

export interface UpdateUserInput {
  nickname?: string;
  avatarUrl?: string;
  avatarFrame?: string;
  cover?: string;
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
  email?: string | null;
  wechat?: string | null;
  qq?: string | null;
  whatsup?: string | null;
  lastOnline?: Date | null;
};

// applyProfilePrivacy 遮蔽的字段，整组交给一次 canViewProfileFields 判定。
const PROFILE_PRIVACY_FIELDS = [
  'phoneNumber',
  'email',
  'wechat',
  'qq',
  'whatsup',
  'lastOnline',
] as const;

type ProfileMembershipUser = {
  vipLevel?: number;
  vipExpiresAt?: Date | null;
};

// 搜索 / 资料页 / 本人（PATCH、注销）共用的映射：vipLevel 只给按到期折算后的有效档，
// 存储档与 vipExpiresAt 在这里剥掉，不靠 DTO 兜底。会员外观对象（membership）与
// storedVipLevel 不在 APP / 管理台任何读取路径上，已从三个视图的契约里去掉，不再拼装。
function toUserView<T extends ProfileMembershipUser>(
  user: T,
  avatarFrameAppearance: AvatarFramePublicAppearance | null = null,
  now = new Date(),
) {
  const { vipLevel = 0, vipExpiresAt = null, ...profile } = user;
  return {
    ...profile,
    vipLevel: resolveEffectiveMembershipLevel({ vipLevel, vipExpiresAt }, now),
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
// fields (nickname) and format-validated fields (avatar URLs), which the DTO
// layer rejects when blank so they never reach here empty. email is deliberately
// absent from UpdateUserInput altogether: it is the login identity, not profile
// data, and changing it is the first step of a password-reset account takeover.
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
  private readonly storagePublicObjectBases: readonly string[];

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
    this.storagePublicObjectBases = storagePublicObjectBasesFromConfig(
      this.config,
    );
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
      const normalized = normalizeUserIdAlias(id);
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
      const normalized = normalizeUserIdAlias(id).toLowerCase();
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
      this.storagePublicObjectBases,
      'profile image url',
    );
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

    // 「可通过账号号码添加我」的收口点。这是唯一能把账号号码变成 userID 的接口，
    // 关掉之后这条发现路径就断了，好友请求根本形不成 —— 比在发请求时判来源可靠，
    // 因为来源是客户端自报的、可以随便填。返回 null 而不是抛错：能区分「不存在」
    // 和「拒绝被搜到」的话，这个接口就成了设置探测器。
    // 自己搜自己不挡：用户要能核对自己的账号号码。
    if (viewerId !== user.id) {
      const { addMeByAccount } = await this.privacySettings.getSettings(
        user.id,
      );
      if (!addMeByAccount) return null;
    }

    const [filteredUser, appearances] = await Promise.all([
      this.applyProfilePrivacy(user, viewerId),
      this.avatarFrames.resolvePublicAppearances([user.id]),
    ]);
    return toUserView(
      filteredUser,
      appearances.get(user.id)?.avatarFrame ?? null,
    );
  }

  async findOne(id: string, viewerId?: string) {
    // 「成员可查看他人资料」的 enforcement 点。开关存在会话行上,但资料页是
    // 用户域的端点,客户端只要知道 userId 就能直接打 —— 群设置里关掉之后
    // 前端隐藏入口只是装饰,真正的门必须在这里。
    if (viewerId) await this.assertProfileVisibleTo(viewerId, id);
    const [user, displayIcons, appearances] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id },
        select: PUBLIC_SELECT,
      }),
      this.iconService.getDisplayIconsForUser(id),
      this.avatarFrames.resolvePublicAppearances([id]),
    ]);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    // 与账号搜索（只认 ACTIVE）对齐：注销账号对他人就是不存在，回同一个 404，
    // 不给「注销过」和「从没有过」留可区分的差异。本人不挡。
    if (user.status === UserStatus.DELETED && viewerId !== id) {
      throw new NotFoundException(`User ${id} not found`);
    }
    const filteredUser = await this.applyProfilePrivacy(user, viewerId);
    // 「我今天赞过没」走 like 模块自己的状态接口，资料页只带被赞总数。
    return {
      ...toUserView(filteredUser, appearances.get(id)?.avatarFrame ?? null),
      displayIcons,
      likeCount: user.receivedLikeCount,
    };
  }

  /**
   * 只通过关着「成员可查看他人资料」的独立群认识的两个人之间,资料页不可见。
   * 本人、好友、对方先发过好友申请、同圈子成员、任一共同群开着开关、
   * 本人是某个共同群的群主/管理员 —— 都放行(判定见 standalone-group-policy-gate)。
   */
  private async assertProfileVisibleTo(
    viewerId: string,
    targetId: string,
  ): Promise<void> {
    const blocked = await isBlockedByStandaloneGroupPolicy(
      this.prisma,
      viewerId,
      targetId,
      'membersCanViewProfiles',
    );
    if (blocked) {
      throw new ForbiddenException({
        message: '该群不允许查看成员资料',
        errorCode: ChatErrorCode.MemberProfileForbidden,
      });
    }
  }

  private async applyProfilePrivacy<T extends ProfilePrivacyUser>(
    user: T,
    viewerId?: string,
  ): Promise<T> {
    const isSelf = viewerId === user.id;
    // isFriend is intentionally hardcoded to false here: phone/email/wechat/qq
    // visibility is a global show/hide switch in the current model, not
    // friend-aware. If a "friends-only" profile tier is ever added, thread the
    // real friendship status through instead of this literal.
    // 六个字段只读一次对方的隐私设置（canViewProfileFields），规则与单字段版同一份。
    // 「显示在线时间」关着时资料页的 lastOnline 也要抹掉:聊天 presence 通道
    // 已经收口,REST 这边不收就是第二条信道。
    const visible = await this.privacySettings.canViewProfileFields(
      user.id,
      PROFILE_PRIVACY_FIELDS,
      isSelf,
      false,
    );

    return {
      ...user,
      phoneNumber: visible.phoneNumber ? user.phoneNumber : null,
      email: visible.email ? user.email : null,
      wechat: visible.wechat ? user.wechat : null,
      qq: visible.qq ? user.qq : null,
      whatsup: visible.whatsup ? user.whatsup : null,
      lastOnline: visible.lastOnline ? user.lastOnline : null,
    };
  }

  /**
   * update 只需要知道这个 id 存在。此前为了判 404 把 findOne 的整条资料流水线
   * （隐私判定、图标、头像框）跑一遍，结果全部丢掉。
   */
  private async assertUserExists(id: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!user) throw new NotFoundException(`User ${id} not found`);
  }

  async update(id: string, input: UpdateUserInput) {
    this.assertUrlsAreSafe(input);
    await this.assertUserExists(id);
    const normalizedInput = normalizeUpdateInput(input);
    const user = await this.prisma.$transaction(async (tx) => {
      // 响应按 SelfUserDto 序列化：与 /auth/me 同一份本人视图的列。
      const updated = await tx.user.update({
        where: { id },
        data: normalizedInput,
        select: USER_ME_SELECT,
      });
      return updated;
    });
    const [displayIcons, appearances] = await Promise.all([
      this.iconService.getDisplayIconsForUser(id),
      this.avatarFrames.resolvePublicAppearances([id]),
    ]);
    await this.realtimeService.invalidateUserProfileSummaryCache(id);
    await this.realtimeService.broadcastUserProfileSummary(id);

    return {
      ...toUserView(user, appearances.get(id)?.avatarFrame ?? null),
      displayIcons,
    };
  }

  async remove(id: string) {
    await this.findOne(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.DELETED },
      select: PUBLIC_SELECT,
    });
    // A deleted user must lose every active session; otherwise an attacker
    // (or the user themselves) can keep refreshing tokens for up to 7 days.
    await this.refreshTokens.revokeAll(id);
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'user_account_removed',
      targetId: id,
      result: 'success',
      entityType: 'user',
      entityId: id,
    });
    const displayIcons = await this.iconService.getDisplayIconsForUser(id);
    let avatarFrameAppearance: AvatarFramePublicAppearance | null = null;
    try {
      const appearances = await this.avatarFrames.resolvePublicAppearances([
        id,
      ]);
      avatarFrameAppearance = appearances.get(id)?.avatarFrame ?? null;
    } catch (error) {
      this.logger.warn(
        `Avatar-frame appearance lookup failed after user deletion (user=${id}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // Map through toUserView like every other user response: resolve the
    // effective (expiry-aware) vipLevel, so an expired paid tier can't leak its
    // stored level or expiry in the deletion body.
    return {
      ...toUserView(user, avatarFrameAppearance),
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
