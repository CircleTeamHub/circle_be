import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallEndReason, CallParticipantStatus } from 'src/generated/prisma';
import { reportOperationalError } from 'src/logging/error-aggregation.service';
import { ApnsVoipClient } from 'src/notification/apns-voip.client';
import type { ApnsEnvironment } from 'src/notification/notification.dto';
import {
  NotificationPushService,
  type TokenDeliveryOutcome,
} from 'src/notification/notification-push.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { deriveDeclineTokenKey, issueDeclineToken } from './call-decline-token';

/**
 * 推送来电（设计见 circle-im 仓库 docs/superpowers/specs/2026-10-26-push-incoming-calls-design.md）。
 *
 * WS 邀请照发（覆盖在线端），这里并行给每台「声明了能处理来电推送」的设备发：
 * - iOS：PushKit VoIP，直连 APNs；App 原生层当场上报 CallKit 响铃；
 * - 安卓：极光透传；App 原生层画全屏来电通知。
 * 撤销（取消 / 超时 / 结束 / 本人在别的设备接听或拒接）只发安卓透传：iOS 每一条 VoIP
 * 推送都必须上报一通来电，拿它当撤销会闪一下来电界面；CallKit 响铃期间 App 在后台
 * 运行，靠 WS 与 GET /calls/current 对账收掉。
 *
 * 与聊天推送同一哲学：尽力而为、不走 outbox、不重试 —— 振铃只有 45 秒，TTL 卡在
 * 振铃截止，过期的来电推送没有价值。任何失败只记日志与指标，绝不抛回通话流程。
 */

/** 推送载荷协议版本；客户端登记时声明自己能处理的版本（DevicePushToken.callPushVersion）。 */
export const CALL_PUSH_VERSION = 1;
/** 每人每个通道最多推几台设备（按最近登记的算）。 */
const MAX_CALL_DEVICES_PER_PROVIDER = 5;
const NAME_MAX_CHARS = 32;

export type CallDismissReason =
  | 'canceled'
  | 'ended'
  | 'missed'
  | 'failed'
  | 'answered_elsewhere'
  | 'declined_elsewhere';

export type CallPushInvite = {
  callId: string;
  conversationID: string;
  sessionType: 'single' | 'group';
  callType: 'AUDIO' | 'VIDEO';
  initiator: { id: string; nickname: string };
  expiresAt: string;
};

type CallPushTarget = {
  userID: string;
  token: string;
  provider: 'apns_voip' | 'jpush';
  apnsEnvironment: ApnsEnvironment;
};

type EndedCall = {
  id: string;
  participants?: Array<{ userID: string; status: string }>;
};

function truncateChars(value: string, max: number): string {
  const chars = [...value.trim()];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

export function dismissReasonFor(endReason: CallEndReason): CallDismissReason {
  if (endReason === CallEndReason.CANCELED) return 'canceled';
  if (endReason === CallEndReason.NO_ANSWER) return 'missed';
  if (endReason === CallEndReason.ERROR) return 'failed';
  return 'ended';
}

@Injectable()
export class CallPushService implements OnModuleDestroy {
  private readonly logger = new Logger(CallPushService.name);
  private readonly inFlight = new Set<Promise<void>>();
  private readonly declineKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: NotificationPushService,
    private readonly apns: ApnsVoipClient,
    private readonly config: ConfigService,
  ) {
    const secret =
      config.get<string>('CALL_PUSH_ACTION_SECRET')?.trim() ||
      config.get<string>('SECRET') ||
      '';
    this.declineKey = deriveDeclineTokenKey(secret);
  }

  getDeclineKey(): Buffer {
    return this.declineKey;
  }

  /** 邀请广播之后调用：立即返回，推送在后台发。 */
  ringInvitees(invite: CallPushInvite, inviteeIDs: string[]): void {
    this.track('invite', invite.callId, () =>
      this.sendInvite(invite, inviteeIDs),
    );
  }

  /** 本人在某台设备上接听 / 拒接了：收掉他其他设备上的振铃。 */
  dismissForUser(
    callId: string,
    userID: string,
    reason: Extract<
      CallDismissReason,
      'answered_elsewhere' | 'declined_elsewhere'
    >,
  ): void {
    this.track('dismiss', callId, () =>
      this.sendDismiss(callId, [userID], reason),
    );
  }

  /**
   * 通话终局（六个终局写入的赢家都会走到这里）：收掉所有「被邀请过、还没接也没拒」的人
   * 的振铃。终局写入有的先把 INVITED 改成 MISSED、有的不改，所以两种状态都算。
   * 接听过的人在接听时已经收过 answered_elsewhere，拒接的人收过 declined_elsewhere。
   */
  dismissForEndedCall(call: EndedCall, endReason: CallEndReason): void {
    const userIDs = [
      ...new Set(
        (call.participants ?? [])
          .filter(
            (participant) =>
              participant.status === CallParticipantStatus.INVITED ||
              participant.status === CallParticipantStatus.MISSED,
          )
          .map((participant) => participant.userID),
      ),
    ];
    if (userIDs.length === 0) return;
    this.track('dismiss', call.id, () =>
      this.sendDismiss(call.id, userIDs, dismissReasonFor(endReason)),
    );
  }

  /** 等在途推送落定（停机与测试用）。 */
  async flushPending(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  onModuleDestroy(): Promise<void> {
    return this.flushPending();
  }

  private track(kind: string, callId: string, run: () => Promise<void>): void {
    const promise: Promise<void> = run()
      .catch((error: unknown) => {
        this.logger.warn(
          `call.push_failed kind=${kind} callId=${callId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        reportOperationalError(error, {
          component: 'CallPushService',
          operation: kind,
          kind: 'call_push',
        });
      })
      .finally(() => {
        this.inFlight.delete(promise);
      });
    this.inFlight.add(promise);
  }

  private async sendInvite(
    invite: CallPushInvite,
    inviteeIDs: string[],
  ): Promise<void> {
    const expiresAt = new Date(invite.expiresAt);
    const ttlSeconds = (expiresAt.getTime() - Date.now()) / 1000;
    if (inviteeIDs.length === 0 || !Number.isFinite(ttlSeconds)) return;
    if (ttlSeconds <= 0) return;
    const targets = await this.listTargets(inviteeIDs);
    if (targets.length === 0) return;

    const groupName =
      invite.sessionType === 'group'
        ? await this.resolveGroupName(invite.conversationID)
        : null;
    const base: Record<string, string> = {
      v: String(CALL_PUSH_VERSION),
      type: 'call.invite',
      callId: invite.callId,
      callType: invite.callType,
      sessionType: invite.sessionType,
      callerId: invite.initiator.id,
      callerName: truncateChars(invite.initiator.nickname, NAME_MAX_CHARS),
      expiresAt: expiresAt.toISOString(),
      ...(groupName
        ? { groupName: truncateChars(groupName, NAME_MAX_CHARS) }
        : {}),
    };
    const payloadFor = (userID: string) => ({
      ...base,
      declineToken: issueDeclineToken(
        this.declineKey,
        invite.callId,
        userID,
        expiresAt,
      ),
    });

    const voip = targets.filter((target) => target.provider === 'apns_voip');
    const jpush = targets.filter((target) => target.provider === 'jpush');
    const [voipOutcomes, jpushOutcomes] = await Promise.all([
      this.sendVoip(voip, payloadFor, expiresAt),
      // 每个人的拒接令牌不同，按人分开发；被叫最多 CALL_MAX_PARTICIPANTS 人。
      Promise.all(
        this.groupByUser(jpush).map(([userID, tokens]) =>
          this.push.sendJPushCustomMessages(tokens, {
            type: 'call.invite',
            extras: payloadFor(userID),
            ttlSeconds,
          }),
        ),
      ).then((nested) => nested.flat()),
    ]);
    await this.settle(voipOutcomes, jpushOutcomes);
    this.logResult('invite', invite.callId, voipOutcomes, jpushOutcomes);
  }

  private async sendDismiss(
    callId: string,
    userIDs: string[],
    reason: CallDismissReason,
  ): Promise<void> {
    const targets = (await this.listTargets(userIDs)).filter(
      (target) => target.provider === 'jpush',
    );
    if (targets.length === 0) return;
    // 撤销追着邀请跑：邀请的 TTL 是剩余振铃时间，撤销留一整个振铃窗口就一定够；
    // 多留几秒无害（原生层收不到对应的振铃就什么都不做），少留会漏收。
    const outcomes = await this.push.sendJPushCustomMessages(
      targets.map((target) => target.token),
      {
        type: 'call.dismiss',
        extras: {
          v: String(CALL_PUSH_VERSION),
          type: 'call.dismiss',
          callId,
          reason,
        },
        ttlSeconds: this.ringTimeoutSeconds(),
      },
    );
    await this.settle([], outcomes);
    this.logResult(`dismiss:${reason}`, callId, [], outcomes);
  }

  private async sendVoip(
    targets: CallPushTarget[],
    payloadFor: (userID: string) => Record<string, string>,
    expiresAt: Date,
  ): Promise<TokenDeliveryOutcome[]> {
    if (targets.length === 0 || !this.apns.isConfigured()) return [];
    return Promise.all(
      targets.map((target) =>
        this.apns.send({
          token: target.token,
          environment: target.apnsEnvironment,
          payload: { call: payloadFor(target.userID) },
          expiresAt,
        }),
      ),
    );
  }

  private async settle(
    voip: TokenDeliveryOutcome[],
    jpush: TokenDeliveryOutcome[],
  ): Promise<void> {
    await Promise.all([
      voip.length > 0
        ? this.push.settleDirectOutcomes('apns_voip', voip)
        : Promise.resolve(),
      jpush.length > 0
        ? this.push.settleDirectOutcomes('jpush', jpush)
        : Promise.resolve(),
    ]);
  }

  /** 只记数量与结论，不记 token、昵称。 */
  private logResult(
    kind: string,
    callId: string,
    voip: TokenDeliveryOutcome[],
    jpush: TokenDeliveryOutcome[],
  ): void {
    const failed = [...voip, ...jpush].filter(
      (outcome) => outcome.status !== 'SENT',
    );
    const errors = [...new Set(failed.map((outcome) => outcome.error))].join(
      ',',
    );
    this.logger.log(
      `call.push kind=${kind} callId=${callId} voip=${voip.length} jpush=${jpush.length} failed=${failed.length}${
        errors ? ` errors=${errors}` : ''
      }`,
    );
  }

  /**
   * 能处理来电推送的设备：iOS 的 VoIP token，安卓的极光 token；都要求客户端登记时声明了
   * callPushVersion（旧客户端收到也不会响铃）。iOS 的极光 token 不在其列 —— iOS 来电只走 VoIP。
   */
  private async listTargets(userIDs: string[]): Promise<CallPushTarget[]> {
    const rows = await this.prisma.devicePushToken.findMany({
      where: {
        userID: { in: userIDs },
        disabledAt: null,
        callPushVersion: { gte: CALL_PUSH_VERSION },
        OR: [
          { provider: 'apns_voip', platform: 'ios' },
          { provider: 'jpush', platform: 'android' },
        ],
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: {
        userID: true,
        token: true,
        provider: true,
        apnsEnvironment: true,
      },
      // 被叫最多 CALL_MAX_PARTICIPANTS 人，每人每通道登记上限 20 台：兜底封顶。
      take: userIDs.length * 2 * 20,
    });
    const counts = new Map<string, number>();
    const targets: CallPushTarget[] = [];
    for (const row of rows) {
      const key = `${row.userID}:${row.provider}`;
      const count = counts.get(key) ?? 0;
      if (count >= MAX_CALL_DEVICES_PER_PROVIDER) continue;
      counts.set(key, count + 1);
      targets.push({
        userID: row.userID,
        token: row.token,
        provider: row.provider as CallPushTarget['provider'],
        apnsEnvironment:
          row.apnsEnvironment === 'development' ? 'development' : 'production',
      });
    }
    return targets;
  }

  private groupByUser(targets: CallPushTarget[]): Array<[string, string[]]> {
    const byUser = new Map<string, string[]>();
    for (const target of targets) {
      byUser.set(target.userID, [
        ...(byUser.get(target.userID) ?? []),
        target.token,
      ]);
    }
    return [...byUser.entries()];
  }

  /**
   * 群名：App 传的是自研聊天的会话 id —— 独立群聊取 ChatConversation.name，圈子群
   * 取 Circle.name；旧形态（Circle.id / groupID 直传）按圈子查。查不到就不带。
   */
  private async resolveGroupName(
    conversationID: string,
  ): Promise<string | null> {
    try {
      const conversation = await this.prisma.chatConversation.findUnique({
        where: { id: conversationID },
        select: { name: true, circleID: true },
      });
      if (conversation?.name?.trim()) return conversation.name.trim();
      const circle = await this.prisma.circle.findFirst({
        where: {
          deleted: false,
          OR: conversation?.circleID
            ? [{ id: conversation.circleID }]
            : [{ id: conversationID }, { groupID: conversationID }],
        },
        select: { name: true },
      });
      return circle?.name?.trim() || null;
    } catch {
      return null;
    }
  }

  /** 与 CallService 同一个配置项（env 校验保证是 >= 5 的整数，默认 45）。 */
  private ringTimeoutSeconds(): number {
    const configured = Number(this.config.get('CALL_RING_TIMEOUT_SECONDS'));
    return Number.isFinite(configured) && configured > 0 ? configured : 45;
  }
}
