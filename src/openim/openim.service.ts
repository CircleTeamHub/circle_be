import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logExternalCallFailure } from 'src/logging/external-service.logger';
import { logExternalCallSlow } from 'src/logging/performance-event.logger';

export const OPENIM_REQUEST_TIMEOUT_MS = 5_000;
const OPENIM_ADMIN_TOKEN_FAILURE_COOLDOWN_MS = 30_000;
const OPENIM_HTTP_ERROR_BODY_LIMIT = 300;

/**
 * Raw OpenIM message (sdkws.MsgData) as returned by /msg/pull_msg_by_seq.
 * Field names mirror OpenIM's wire shape (camelCase); `content` is base64.
 */
export interface OpenimMessage {
  clientMsgID: string;
  serverMsgID: string;
  sendID: string;
  recvID: string;
  groupID: string;
  senderPlatformID: number;
  senderNickname: string;
  senderFaceURL: string;
  sessionType: number;
  msgFrom: number;
  contentType: number;
  content: string;
  seq: number;
  sendTime: number;
  createTime: number;
  status: number;
  isRead: boolean;
  attachedInfo: string;
  ex: string;
}

@Injectable()
export class OpenimService implements OnModuleInit {
  private readonly logger = new Logger(OpenimService.name);
  private readonly loggingConfig = createLoggingConfig();
  private adminToken: string | null = null;
  private adminTokenExpiresAt: number = 0;
  private adminTokenRetryAfter: number = 0;
  /** In-flight refresh promise — shared across concurrent callers to prevent thundering herd. */
  private adminTokenRefreshPromise: Promise<string> | null = null;

  private readonly apiUrl: string;
  private readonly adminSecret: string;
  private readonly enabled: boolean;

  constructor(private config: ConfigService) {
    this.apiUrl = this.config.get<string>('OPENIM_API_URL') ?? '';
    this.adminSecret = this.config.get<string>('OPENIM_ADMIN_SECRET') ?? '';
    this.enabled = Boolean(this.apiUrl && this.adminSecret);
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn(
        'OpenIM is not configured (OPENIM_API_URL or OPENIM_ADMIN_SECRET missing). IM features will be skipped.',
      );
    }
  }

  // ─── Admin Token ────────────────────────────────────────────────────────────

  private async getAdminToken(): Promise<string> {
    if (this.adminToken && Date.now() < this.adminTokenExpiresAt) {
      return this.adminToken;
    }

    if (Date.now() < this.adminTokenRetryAfter) {
      throw new Error(
        'OpenIM unavailable: admin token refresh is cooling down',
      );
    }

    // Return the in-flight promise to all concurrent callers so we only make
    // one refresh request even under a login burst (thundering herd prevention).
    if (this.adminTokenRefreshPromise) {
      return this.adminTokenRefreshPromise;
    }

    this.adminTokenRefreshPromise = this.fetchAdminToken()
      .catch((error) => {
        this.adminTokenRetryAfter =
          Date.now() + OPENIM_ADMIN_TOKEN_FAILURE_COOLDOWN_MS;
        throw error;
      })
      .finally(() => {
        this.adminTokenRefreshPromise = null;
      });
    return this.adminTokenRefreshPromise;
  }

  private async fetchAdminToken(): Promise<string> {
    const res = await this.post<{ token: string }>('/auth/get_admin_token', {
      secret: this.adminSecret,
      platformID: 1,
      userID: 'imAdmin',
    });

    // Cache for 20 hours (tokens typically last 24h)
    this.adminToken = res.token;
    this.adminTokenExpiresAt = Date.now() + 20 * 60 * 60 * 1000;
    this.adminTokenRetryAfter = 0;
    return this.adminToken;
  }

  // ─── User ────────────────────────────────────────────────────────────────────

  /**
   * OpenIM v3.8 rejects userIDs containing characters its validator deems
   * "illegal" (notably hyphens), so we strip them from PostgreSQL UUIDs before
   * sending them across the boundary. Callers keep using `User.id` as-is.
   */
  static toImUserId(userId: string): string {
    return userId.replace(/-/g, '');
  }

  /**
   * OpenIM's 1:1 conversation id: `si_` + the two IM userIDs sorted ascending
   * and joined by `_`. Sorting makes it identical regardless of arg order.
   */
  static singleConversationID(userIdA: string, userIdB: string): string {
    const [lo, hi] = [
      OpenimService.toImUserId(userIdA),
      OpenimService.toImUserId(userIdB),
    ].sort();
    return `si_${lo}_${hi}`;
  }

  /**
   * Register a user in OpenIM. Called during business registration.
   * Uses the circle_be User.id (UUID) as the OpenIM userID for 1:1 mapping.
   */
  async registerUser(
    userID: string,
    nickname: string,
    avatarUrl?: string | null,
  ): Promise<void> {
    if (!this.enabled) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/user/user_register',
      {
        users: [
          {
            userID: OpenimService.toImUserId(userID),
            nickname,
            faceURL: avatarUrl ?? '',
          },
        ],
      },
      adminToken,
    );
  }

  /**
   * Update a user's OpenIM profile (nickname / avatar). OpenIM keeps its own copy
   * of nickname+faceURL (set at registerUser) and surfaces it as the conversation
   * showName/faceURL; without this, business-side profile edits never reach chats.
   * Only the provided fields are sent. `avatarUrl: null` clears the face URL.
   */
  async updateUserInfo(
    userID: string,
    updates: { nickname?: string; avatarUrl?: string | null },
  ): Promise<void> {
    if (!this.enabled) return;
    if (updates.nickname === undefined && updates.avatarUrl === undefined) {
      return;
    }

    const userInfo: Record<string, unknown> = {
      userID: OpenimService.toImUserId(userID),
    };
    if (updates.nickname !== undefined) {
      userInfo.nickname = updates.nickname;
    }
    if (updates.avatarUrl !== undefined) {
      userInfo.faceURL = updates.avatarUrl ?? '';
    }

    const adminToken = await this.getAdminToken();
    await this.post('/user/update_user_info', { userInfo }, adminToken);
  }

  /**
   * Clear a user's messages in the given conversations (their own view only).
   * Used when deleting a friend so a later re-add starts from a clean history
   * instead of stacking a second set of intro messages onto the old thread.
   */
  async clearConversationMessages(
    userID: string,
    conversationIDs: string[],
  ): Promise<void> {
    if (!this.enabled || conversationIDs.length === 0) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/msg/clear_conversation_msg',
      {
        userID: OpenimService.toImUserId(userID),
        conversationIDs,
        deleteSyncOpt: {
          isSyncSelf: true,
          isSyncOther: false,
        },
      },
      adminToken,
    );
  }

  /**
   * Get an IM token for a user. Called during business login/register.
   * platformID: 1=iOS, 2=Android, 5=Web
   */
  async getUserToken(userID: string, platformID = 2): Promise<string> {
    if (!this.enabled) return '';

    const adminToken = await this.getAdminToken();
    const res = await this.post<{ token: string }>(
      '/auth/get_user_token',
      { userID: OpenimService.toImUserId(userID), platformID },
      adminToken,
    );
    return res.token;
  }

  // ─── Group ───────────────────────────────────────────────────────────────────

  async createGroup(
    groupID: string,
    groupName: string,
    ownerUserID: string,
    memberUserIDs: string[] = [],
  ): Promise<void> {
    if (!this.enabled) return;

    const owner = OpenimService.toImUserId(ownerUserID);
    // OpenIM 要求 ownerUserID 放在请求顶层；放进 groupInfo 会被判为空 → ArgsError("ownerUserID is empty")。
    // owner 由服务端自动入群，若仍出现在 memberUserIDs 里会触发 ArgsError("group member repeated")，故剔除。
    const members = memberUserIDs
      .map(OpenimService.toImUserId)
      .filter((id) => id !== owner);

    const adminToken = await this.getAdminToken();
    await this.post(
      '/group/create_group',
      {
        ownerUserID: owner,
        memberUserIDs: members,
        groupInfo: {
          groupID,
          groupName,
          groupType: 2, // 2 = work group
        },
      },
      adminToken,
    );
  }

  async addGroupMembers(groupID: string, userIDs: string[]): Promise<void> {
    if (!this.enabled) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/group/invite_user_to_group',
      {
        groupID,
        invitedUserIDs: userIDs.map(OpenimService.toImUserId),
        reason: '',
      },
      adminToken,
    );
  }

  async removeGroupMember(groupID: string, userID: string): Promise<void> {
    if (!this.enabled) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/group/kick_group',
      {
        groupID,
        kickedUserIDs: [OpenimService.toImUserId(userID)],
        reason: '',
      },
      adminToken,
    );
  }

  async isGroupMember(groupID: string, userID: string): Promise<boolean> {
    if (!this.enabled) return false;

    const imUserID = OpenimService.toImUserId(userID);
    const adminToken = await this.getAdminToken();
    const res = await this.post<{ members?: Array<{ userID: string }> }>(
      '/group/get_group_members_info',
      {
        groupID,
        userIDs: [imUserID],
      },
      adminToken,
    );

    return (res.members ?? []).some((member) => member.userID === imUserID);
  }

  // ─── Message history (chat-history restore) ──────────────────────────────────

  /**
   * Conversation-global newest seq (OpenIM's authoritative max). Used as the
   * upper bound for restore pagination. Returns 0 when empty/unavailable.
   */
  async getConversationMaxSeq(
    userID: string,
    conversationID: string,
  ): Promise<number> {
    if (!this.enabled) return 0;

    const adminToken = await this.getAdminToken();
    const res = await this.post<{
      seqs?: Record<string, { maxSeq?: number }>;
    }>(
      '/msg/get_conversations_has_read_and_max_seq',
      {
        userID: OpenimService.toImUserId(userID),
        conversationIDs: [conversationID],
      },
      adminToken,
    );
    return Number(res.seqs?.[conversationID]?.maxSeq ?? 0);
  }

  /**
   * Pull a conversation's messages by seq range (OpenIM /msg/pull_msg_by_seq).
   * Pulled as `userID` (admin token may act for any conversation member); OpenIM
   * applies its own visibility/revoke/delete filtering. order=1 (Desc) returns
   * the newest up-to `num` messages within [begin, end].
   *
   * NOTE: OpenIM's jsonpb serializes the map value's field as capital `Msgs`
   * (not camelCase) — read `block.Msgs`, not `block.msgs`.
   */
  async pullConversationMessages(params: {
    userID: string;
    conversationID: string;
    begin: number;
    end: number;
    num: number;
  }): Promise<{ messages: OpenimMessage[]; isEnd: boolean }> {
    if (!this.enabled) return { messages: [], isEnd: true };

    const adminToken = await this.getAdminToken();
    const res = await this.post<{
      msgs?: Record<string, { Msgs?: OpenimMessage[]; isEnd?: boolean }>;
    }>(
      '/msg/pull_msg_by_seq',
      {
        userID: OpenimService.toImUserId(params.userID),
        seqRanges: [
          {
            conversationID: params.conversationID,
            begin: params.begin,
            end: params.end,
            num: params.num,
          },
        ],
        order: 1,
      },
      adminToken,
    );
    const block = res.msgs?.[params.conversationID];
    return { messages: block?.Msgs ?? [], isEnd: block?.isEnd ?? true };
  }

  async importFriends(
    ownerUserID: string,
    friendUserIDs: string[],
  ): Promise<void> {
    if (!this.enabled || friendUserIDs.length === 0) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/friend/import_friend',
      {
        ownerUserID: OpenimService.toImUserId(ownerUserID),
        friendUserIDs: friendUserIDs.map(OpenimService.toImUserId),
      },
      adminToken,
    );
  }

  async sendTextMessage(params: {
    sendID: string;
    recvID: string;
    content: string;
    senderNickname?: string | null;
    senderFaceURL?: string | null;
    notOfflinePush?: boolean;
    clientMsgID?: string;
  }): Promise<void> {
    if (!this.enabled) return;

    const senderName = params.senderNickname?.trim() || 'Circle';
    const adminToken = await this.getAdminToken();
    await this.post(
      '/msg/send_msg',
      {
        sendID: OpenimService.toImUserId(params.sendID),
        recvID: OpenimService.toImUserId(params.recvID),
        content: { content: params.content },
        contentType: 101,
        sessionType: 1,
        senderNickname: senderName,
        senderFaceURL: params.senderFaceURL ?? '',
        senderPlatformID: 5,
        isOnlineOnly: false,
        notOfflinePush: params.notOfflinePush ?? false,
        sendTime: Date.now(),
        offlinePushInfo: {
          title: senderName,
          desc: params.content,
          ex: '',
          iOSPushSound: 'default',
          iOSBadgeCount: true,
        },
        ex: '',
        ...(params.clientMsgID ? { clientMsgID: params.clientMsgID } : {}),
      },
      adminToken,
    );
  }

  async deleteFriend(ownerUserID: string, friendUserID: string): Promise<void> {
    if (!this.enabled) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/friend/delete_friend',
      {
        ownerUserID: OpenimService.toImUserId(ownerUserID),
        friendUserID: OpenimService.toImUserId(friendUserID),
      },
      adminToken,
    );
  }

  async addBlacklist(ownerUserID: string, blackUserID: string): Promise<void> {
    if (!this.enabled) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/friend/add_black',
      {
        ownerUserID: OpenimService.toImUserId(ownerUserID),
        blackUserID: OpenimService.toImUserId(blackUserID),
        ex: '',
      },
      adminToken,
    );
  }

  async removeBlacklist(
    ownerUserID: string,
    blackUserID: string,
  ): Promise<void> {
    if (!this.enabled) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/friend/remove_black',
      {
        ownerUserID: OpenimService.toImUserId(ownerUserID),
        blackUserID: OpenimService.toImUserId(blackUserID),
      },
      adminToken,
    );
  }

  /**
   * 解散群。解散后群消息对客户端不再可见，等价于「销毁即清」。
   * 路径已核实：/group/dismiss_group（admin token）。
   */
  async dismissGroup(groupID: string): Promise<void> {
    if (!this.enabled) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/group/dismiss_group',
      { groupID, deleteMember: true },
      adminToken,
    );
  }

  /**
   * 强制某用户在指定端下线（清理访客会话）。
   * ⚠️ 路径按部署的 OpenIM 版本确认；调用方需容忍其失败（best-effort）。
   * platformID: 5 = Web
   */
  async forceLogout(userID: string, platformID = 5): Promise<void> {
    if (!this.enabled) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/auth/force_logout',
      { userID: OpenimService.toImUserId(userID), platformID },
      adminToken,
    );
  }

  // ─── HTTP helper ─────────────────────────────────────────────────────────────

  private async post<T = void>(
    path: string,
    body: Record<string, unknown>,
    token?: string,
    retryOnAuthError = true,
  ): Promise<T> {
    const start = Date.now();
    let result: 'success' | 'failure' = 'success';
    const { randomUUID } = await import('crypto');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Use UUID so concurrent requests each get a unique trace ID in OpenIM logs.
      operationID: randomUUID(),
    };
    if (token) {
      headers['token'] = token;
    }

    try {
      const response = await fetch(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OPENIM_REQUEST_TIMEOUT_MS),
      });

      if (response.ok === false) {
        const text = await response.text();
        const detail = text.slice(0, OPENIM_HTTP_ERROR_BODY_LIMIT);
        throw new Error(`OpenIM HTTP ${response.status}: ${detail}`);
      }

      const json = (await response.json()) as {
        errCode: number;
        errMsg?: string;
        errDlt?: string;
        data?: T;
      };

      if (json.errCode !== 0) {
        if (token && retryOnAuthError && this.isAdminTokenError(json)) {
          this.adminToken = null;
          this.adminTokenExpiresAt = 0;
          const freshToken = await this.getAdminToken();
          return this.post(path, body, freshToken, false);
        }

        const message = json.errMsg ?? String(json.errCode);
        const detail = json.errDlt ? ` (${json.errDlt})` : '';
        this.logger.error(`OpenIM API error [${path}]: ${message}${detail}`);
        throw new Error(`OpenIM error: ${message}${detail}`);
      }

      return json.data as T;
    } catch (error) {
      result = 'failure';
      logExternalCallFailure(this.logger, {
        enabled: this.loggingConfig.externalLogOn,
        service: 'openim',
        operation: path,
        durationMs: Date.now() - start,
        error,
      });
      throw error;
    } finally {
      logExternalCallSlow(this.logger, {
        enabled: this.loggingConfig.performanceLogOn,
        service: 'openim',
        operation: path,
        durationMs: Date.now() - start,
        thresholdMs: this.loggingConfig.slowExternalMs,
        result,
      });
    }
  }

  private isAdminTokenError(error: {
    errCode: number;
    errMsg?: string;
    errDlt?: string;
  }): boolean {
    if ([1501, 1503].includes(error.errCode)) {
      return true;
    }

    const message = `${error.errMsg ?? ''} ${error.errDlt ?? ''}`;
    return (
      /token/i.test(message) &&
      /(invalid|expired|expire|鉴权|过期)/i.test(message)
    );
  }
}
