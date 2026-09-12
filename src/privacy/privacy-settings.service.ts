import { Prisma } from 'src/generated/prisma';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrivacyErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import { SensitiveWordService } from 'src/sensitive-word/sensitive-word.service';
import { lockUserRelationshipState } from 'src/utils/user-relationship-lock';
import {
  AUTO_REPLY_TEXT_MAX_CODE_POINTS,
  MOMENTS_VISIBILITY_OPTIONS,
  PERMISSION_OPTIONS,
  PrivacySettingsDto,
  UpdatePrivacySettingsDto,
} from './privacy-settings.dto';
import { isBurnDurationChoice } from 'src/common/burn-durations';
import { RedisService } from 'src/redis/redis.service';
import {
  PRESENCE_VISIBILITY_CHANGED,
  PRIVACY_SETTINGS_CHANGED_CHANNEL,
  type PresenceVisibilityChangedEvent,
  privacySettingsEvents,
} from './privacy-events';

const DEFAULT_PRIVACY_SETTINGS: PrivacySettingsDto = {
  // 0 = 关闭。getSettings 读到没有行时不写库,所以从没进过隐私设置的用户
  // 一律走这份默认值 —— 默认非 0 等于替他们全体开了「历史只看得到最近 N 天」,
  // 而这是个查看者侧的读过滤(chat.service.ts selfDestructCutoff),开着不会有
  // 任何报错或提示,只是消息安静地翻不到。自毁是隐私功能,应当由用户主动开启。
  messageSelfDestructSec: 0,
  momentsVisibility: 'ALL',
  allowStrangerMessages: true,
  showPhone: false,
  // 注册邮箱是账号找回入口 —— 归 showPhone 那档「主动公开」,不是 showWechat/showQQ
  // 那档「默认公开」。收紧存量的理由见 20260907000000_add_show_email_privacy。
  showEmail: false,
  showWechat: true,
  showQQ: true,
  showWhatsup: true,
  addMeByAccount: true,
  addMeByPhone: false,
  addMeByQrCode: true,
  addMeByGroup: true,
  callPermission: 'EVERYONE',
  groupInvitePermission: 'EVERYONE',
  directMessageAutoReplyEnabled: false,
  directMessageAutoReplyText: '',
  // 在线状态与「正在输入」默认照旧外露 —— 这三项上线前本来就对所有会话成员
  // 可见,默认收紧等于替存量用户全体改了行为;想藏的人自己关。
  shareOnlineStatus: true,
  shareTypingInDirect: true,
  shareTypingInGroup: true,
};

type StoredPrivacySettings = PrivacySettingsDto & {
  id?: string;
  userID?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

type ProfilePrivacyField =
  | 'phoneNumber'
  | 'email'
  | 'wechat'
  | 'qq'
  | 'whatsup'
  | 'lastOnline';

@Injectable()
export class PrivacySettingsService {
  private readonly logger = new Logger(PrivacySettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sensitiveWords: SensitiveWordService,
    private readonly redis: RedisService,
  ) {}

  /**
   * `client` 默认走 this.prisma。需要与一次授权判定串行的调用方必须在共享
   * user lock 的同一事务内传入事务客户端，确保锁一直持有到动作提交。
   */
  async getSettings(
    userId: string,
    client: Pick<Prisma.TransactionClient, 'userPrivacySetting'> = this.prisma,
  ): Promise<PrivacySettingsDto> {
    const existing = await client.userPrivacySetting.findUnique({
      where: { userID: userId },
    });

    if (existing) {
      return this.toDto(existing as StoredPrivacySettings);
    }

    // No row yet → return defaults WITHOUT writing. getSettings is called on
    // every stranger profile view / permission check; lazily creating a row on
    // read would let any viewer trigger a write to the target's row (write
    // amplification). The row is created lazily on the first updateSettings().
    return { ...DEFAULT_PRIVACY_SETTINGS };
  }

  /**
   * Batch variant of {@link getSettings} for callers resolving many users at
   * once (e.g. icon eligibility for a feed page). One query instead of N;
   * users without a row fall back to defaults, matching getSettings.
   */
  async getSettingsForUsers(
    userIds: string[],
  ): Promise<Map<string, PrivacySettingsDto>> {
    const result = new Map<string, PrivacySettingsDto>();
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    if (uniqueIds.length === 0) return result;

    const rows = await this.prisma.userPrivacySetting.findMany({
      where: { userID: { in: uniqueIds } },
    });
    const byUser = new Map(
      rows.map((row) => [
        (row as StoredPrivacySettings).userID as string,
        this.toDto(row as StoredPrivacySettings),
      ]),
    );
    for (const id of uniqueIds) {
      result.set(id, byUser.get(id) ?? { ...DEFAULT_PRIVACY_SETTINGS });
    }
    return result;
  }

  async updateSettings(
    userId: string,
    input: UpdatePrivacySettingsDto,
  ): Promise<PrivacySettingsDto> {
    this.assertValid(input);
    const update = this.compactUpdate(input);
    let presenceWasVisible: boolean | null = null;
    const saved = await this.prisma.$transaction(async (tx) => {
      // Call creation, circle admission, friend removal and blocking all make
      // authorization decisions under this same per-user lock. Without it a
      // stricter privacy setting can return success while a concurrent action
      // still commits from an older snapshot.
      await lockUserRelationshipState(tx, [userId]);
      if (
        input.directMessageAutoReplyEnabled !== undefined ||
        input.directMessageAutoReplyText !== undefined
      ) {
        const current = await this.getSettings(userId, tx);
        this.assertValidAutoReplyState({
          ...current,
          ...update,
        } as PrivacySettingsDto);
      }
      if (input.shareOnlineStatus !== undefined) {
        // 翻转前的值要在同一把锁里读:事务提交后再去比,读到的可能已是本次写入。
        presenceWasVisible = (await this.getSettings(userId, tx))
          .shareOnlineStatus;
      }
      return tx.userPrivacySetting.upsert({
        where: { userID: userId },
        create: { userID: userId, ...DEFAULT_PRIVACY_SETTINGS, ...update },
        update,
      });
    });
    const updated = this.toDto(saved as StoredPrivacySettings);
    // 网关按用户缓存了「正在输入」两个开关,靠 TTL 追平的话 PATCH 落在别的实例
    // 时会留出一段仍在转发的窗口。提交后立刻广播一次失效,让各实例丢掉缓存。
    await this.publishSettingsChanged(userId);
    if (
      presenceWasVisible !== null &&
      presenceWasVisible !== updated.shareOnlineStatus
    ) {
      await this.announcePresenceVisibility(userId);
    }
    return updated;
  }

  /**
   * 跨实例失效通知。Redis 没配就是单实例部署,不是故障;publish 自己吞掉失败,
   * 最坏退回 TTL 追平,所以这里不让它影响已经提交的设置。
   */
  private async publishSettingsChanged(userId: string): Promise<void> {
    if (!this.redis.isEnabled()) return;
    try {
      await this.redis.publish(PRIVACY_SETTINGS_CHANGED_CHANNEL, userId);
    } catch (error) {
      this.logger.warn(
        `privacy settings change publish failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 「显示在线时间」翻转后通知聊天广播层:关掉要立刻把在线点/「N 分钟前在线」
   * 从对方界面收回,打开则把此刻的真实状态补发出去。只在事务提交后发,并且
   * 自己兜住失败 —— 设置已经落库,实时收回是体验增强,不能把成功保存伪装成失败。
   */
  private static readonly ANNOUNCE_ATTEMPTS = 3;
  private static readonly ANNOUNCE_BACKOFF_MS = 100;

  private async announcePresenceVisibility(userId: string): Promise<void> {
    for (
      let attempt = 1;
      attempt <= PrivacySettingsService.ANNOUNCE_ATTEMPTS;
      attempt += 1
    ) {
      const delivered = await this.tryAnnouncePresenceVisibility(userId);
      if (delivered) return;
      if (attempt < PrivacySettingsService.ANNOUNCE_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, PrivacySettingsService.ANNOUNCE_BACKOFF_MS),
        );
      }
    }
    // 重试也没成的话只能留给下一次查询/重连追平:查询侧读的是实时库,所以
    // 设置本身是生效的,只是还连着的客户端界面上那一份要晚一点才收敛。
    this.logger.warn(
      `presence visibility announcement gave up for ${userId} after ${PrivacySettingsService.ANNOUNCE_ATTEMPTS} attempts`,
    );
  }

  /** 返回是否真的把事件发出去了。失败只记一次日志,由调用方决定重试。 */
  private async tryAnnouncePresenceVisibility(
    userId: string,
  ): Promise<boolean> {
    try {
      const [memberships, blocks] = await Promise.all([
        this.prisma.chatMember.findMany({
          where: { userID: userId, leftAt: null },
          select: { conversationID: true },
        }),
        // 与网关上下线广播同一条规则:互相拉黑的人不收(拉黑不动 ChatMember)。
        this.prisma.block.findMany({
          where: { OR: [{ blockerID: userId }, { blockedID: userId }] },
          select: { blockerID: true, blockedID: true },
        }),
      ]);
      const event: PresenceVisibilityChangedEvent = {
        userId,
        conversationIds: memberships.map((m) => m.conversationID),
        excludeUserIds: [
          ...new Set(
            blocks.map((b) =>
              b.blockerID === userId ? b.blockedID : b.blockerID,
            ),
          ),
        ],
      };
      privacySettingsEvents.emit(PRESENCE_VISIBILITY_CHANGED, event);
      return true;
    } catch (error) {
      this.logger.warn(
        `presence visibility event preparation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  async canReceiveStrangerMessage(
    targetUserId: string,
    isFriend: boolean,
  ): Promise<boolean> {
    if (isFriend) return true;
    const settings = await this.getSettings(targetUserId);
    return settings.allowStrangerMessages;
  }

  async canViewProfileField(
    targetUserId: string,
    field: ProfilePrivacyField,
    isSelf: boolean,
    isFriend: boolean,
  ): Promise<boolean> {
    if (isSelf) return true;

    const settings = await this.getSettings(targetUserId);
    if (field === 'phoneNumber') return settings.showPhone;
    if (field === 'email') return settings.showEmail;
    if (field === 'wechat') return settings.showWechat;
    if (field === 'qq') return settings.showQQ;
    if (field === 'whatsup') return settings.showWhatsup;
    if (field === 'lastOnline') return settings.shareOnlineStatus;
    return isFriend;
  }

  async canViewMoments(
    authorUserId: string,
    isSelf: boolean,
    isFriend: boolean,
  ): Promise<boolean> {
    if (isSelf) return true;
    const settings = await this.getSettings(authorUserId);
    return this.momentsVisibleFor(settings, isSelf, isFriend);
  }

  /**
   * Batch variant of getSettings: one query for many users. Users without a row
   * are simply absent from the map; callers fall back to defaults via
   * momentsVisibleFor. Avoids the N+1 that a per-author getSettings loop causes
   * when filtering a whole feed's authors.
   */
  async getSettingsMany(
    userIds: string[],
  ): Promise<Map<string, PrivacySettingsDto>> {
    const byUser = new Map<string, PrivacySettingsDto>();
    if (userIds.length === 0) return byUser;
    const rows = await this.prisma.userPrivacySetting.findMany({
      where: { userID: { in: userIds } },
    });
    for (const row of rows) {
      const stored = row as StoredPrivacySettings;
      byUser.set(stored.userID as string, this.toDto(stored));
    }
    return byUser;
  }

  /**
   * Pure moments-visibility decision over already-loaded settings (or undefined
   * = no row yet → defaults). Shared by canViewMoments and the batch feed path
   * so both apply identical rules.
   */
  momentsVisibleFor(
    settings: PrivacySettingsDto | undefined,
    isSelf: boolean,
    isFriend: boolean,
  ): boolean {
    if (isSelf) return true;
    const visibility =
      settings?.momentsVisibility ?? DEFAULT_PRIVACY_SETTINGS.momentsVisibility;
    if (visibility === 'PRIVATE') return false;
    if (visibility === 'FRIENDS_ONLY') return isFriend;
    return true;
  }

  async canBeInvitedToGroupOrCircle(
    targetUserId: string,
    isFriend: boolean,
    client?: Pick<Prisma.TransactionClient, 'userPrivacySetting'>,
  ): Promise<boolean> {
    const settings = await this.getSettings(targetUserId, client);
    return this.permissionAllows(settings.groupInvitePermission, isFriend);
  }

  async canBeCalled(targetUserId: string, isFriend: boolean): Promise<boolean> {
    const settings = await this.getSettings(targetUserId);
    return this.permissionAllows(settings.callPermission, isFriend);
  }

  private permissionAllows(permission: string, isFriend: boolean) {
    if (permission === 'NONE') return false;
    if (permission === 'FRIENDS_ONLY') return isFriend;
    return true;
  }

  private compactUpdate(input: UpdatePrivacySettingsDto) {
    const compact = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
    if (typeof compact.directMessageAutoReplyText === 'string') {
      compact.directMessageAutoReplyText =
        compact.directMessageAutoReplyText.trim();
    }
    return compact;
  }

  private assertValid(input: UpdatePrivacySettingsDto) {
    if (
      input.messageSelfDestructSec !== undefined &&
      !isBurnDurationChoice(input.messageSelfDestructSec)
    ) {
      throw new BadRequestException({
        message: 'Unsupported self-destruct duration',
        errorCode: PrivacyErrorCode.SelfDestructInvalid,
      });
    }
    if (
      input.momentsVisibility !== undefined &&
      !MOMENTS_VISIBILITY_OPTIONS.includes(input.momentsVisibility)
    ) {
      throw new BadRequestException({
        message: 'Unsupported moments visibility',
        errorCode: PrivacyErrorCode.MomentsVisibilityInvalid,
      });
    }
    if (
      input.callPermission !== undefined &&
      !PERMISSION_OPTIONS.includes(input.callPermission)
    ) {
      throw new BadRequestException({
        message: 'Unsupported call permission',
        errorCode: PrivacyErrorCode.CallPermissionInvalid,
      });
    }
    if (
      input.groupInvitePermission !== undefined &&
      !PERMISSION_OPTIONS.includes(input.groupInvitePermission)
    ) {
      throw new BadRequestException({
        message: 'Unsupported invite permission',
        errorCode: PrivacyErrorCode.InvitePermissionInvalid,
      });
    }
    if (
      input.directMessageAutoReplyEnabled !== undefined &&
      typeof input.directMessageAutoReplyEnabled !== 'boolean'
    ) {
      throw new BadRequestException({
        message: 'Invalid direct-message auto reply setting',
      });
    }
    if (
      input.directMessageAutoReplyText !== undefined &&
      (typeof input.directMessageAutoReplyText !== 'string' ||
        Array.from(input.directMessageAutoReplyText.trim()).length >
          AUTO_REPLY_TEXT_MAX_CODE_POINTS)
    ) {
      throw new BadRequestException({
        message:
          'Direct-message auto reply text must be at most 200 characters',
      });
    }
    const autoReplyText = input.directMessageAutoReplyText?.trim();
    if (autoReplyText && this.sensitiveWords.check(autoReplyText).blocked) {
      throw new BadRequestException({
        message: 'Direct-message auto reply text contains disallowed content',
      });
    }
  }

  private assertValidAutoReplyState(settings: PrivacySettingsDto) {
    if (
      settings.directMessageAutoReplyEnabled &&
      !settings.directMessageAutoReplyText.trim()
    ) {
      throw new BadRequestException({
        message: 'Direct-message auto reply text is required when enabled',
      });
    }
  }

  private toDto(settings: StoredPrivacySettings): PrivacySettingsDto {
    return {
      messageSelfDestructSec:
        settings.messageSelfDestructSec ??
        DEFAULT_PRIVACY_SETTINGS.messageSelfDestructSec,
      momentsVisibility:
        settings.momentsVisibility ??
        DEFAULT_PRIVACY_SETTINGS.momentsVisibility,
      allowStrangerMessages:
        settings.allowStrangerMessages ??
        DEFAULT_PRIVACY_SETTINGS.allowStrangerMessages,
      showPhone: settings.showPhone ?? DEFAULT_PRIVACY_SETTINGS.showPhone,
      showEmail: settings.showEmail ?? DEFAULT_PRIVACY_SETTINGS.showEmail,
      showWechat: settings.showWechat ?? DEFAULT_PRIVACY_SETTINGS.showWechat,
      showQQ: settings.showQQ ?? DEFAULT_PRIVACY_SETTINGS.showQQ,
      showWhatsup: settings.showWhatsup ?? DEFAULT_PRIVACY_SETTINGS.showWhatsup,
      addMeByAccount:
        settings.addMeByAccount ?? DEFAULT_PRIVACY_SETTINGS.addMeByAccount,
      addMeByPhone:
        settings.addMeByPhone ?? DEFAULT_PRIVACY_SETTINGS.addMeByPhone,
      addMeByQrCode:
        settings.addMeByQrCode ?? DEFAULT_PRIVACY_SETTINGS.addMeByQrCode,
      addMeByGroup:
        settings.addMeByGroup ?? DEFAULT_PRIVACY_SETTINGS.addMeByGroup,
      callPermission:
        settings.callPermission ?? DEFAULT_PRIVACY_SETTINGS.callPermission,
      groupInvitePermission:
        settings.groupInvitePermission ??
        DEFAULT_PRIVACY_SETTINGS.groupInvitePermission,
      directMessageAutoReplyEnabled:
        settings.directMessageAutoReplyEnabled ??
        DEFAULT_PRIVACY_SETTINGS.directMessageAutoReplyEnabled,
      directMessageAutoReplyText:
        settings.directMessageAutoReplyText ??
        DEFAULT_PRIVACY_SETTINGS.directMessageAutoReplyText,
      shareOnlineStatus:
        settings.shareOnlineStatus ??
        DEFAULT_PRIVACY_SETTINGS.shareOnlineStatus,
      shareTypingInDirect:
        settings.shareTypingInDirect ??
        DEFAULT_PRIVACY_SETTINGS.shareTypingInDirect,
      shareTypingInGroup:
        settings.shareTypingInGroup ??
        DEFAULT_PRIVACY_SETTINGS.shareTypingInGroup,
    };
  }
}
