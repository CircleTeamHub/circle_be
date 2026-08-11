import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { TrackedCron } from '../metrics/tracked-cron.decorator';
import { Prisma } from 'src/generated/prisma';
import {
  CircleErrorCode,
  CircleInvitationErrorCode,
} from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { ChatCircleSyncService } from 'src/chat/chat-circle-sync.service';
import { ChatService } from 'src/chat/chat.service';
import { ChatSystemMessageService } from 'src/chat/chat-system-message.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { NotificationService } from 'src/notification/notification.service';
import { feedCursorWhere } from 'src/utils/feed-cursor';
import { runSerializableTransaction } from 'src/utils/prisma-tx';
import {
  DEFAULT_INVITATION_LIST_LIMIT,
  InvitationDto,
  InvitationListQueryDto,
  InvitationVerifierDto,
} from './dto/circle-invitation.dto';

// 验证卡片补偿的节流参数。宽限期给 inline 签发留出完成时间。
//
// attempts 上限给到 36(5 分钟一轮 ≈ 3 小时)而不是刚好覆盖 1 小时的 12,
// 是因为「条件 updateMany」是 CAS 而**不是独占租约**:副本 B 若在副本 A 自增之后、
// A 还没发完之前扫表,会读到新的 attempts 值并成功再自增一次,于是一个 5 分钟
// 窗口里可能烧掉多次尝试。重复投递本身无害(clientMessageId 在唯一约束上合并),
// 真正的代价只是预算提前见底、过早打出「永久丢失」的 error 日志。
// 与其为此再加一列租约时间戳(这条补偿路径的严重性远不及转账),不如把预算
// 放宽到能吸收副本倍数 —— 3 副本下仍有 ≈1 小时的真实覆盖。
const VERIFICATION_CARD_GRACE_MS = 2 * 60 * 1000;
// 导出给 metrics/outbox-depth.service：死信行的判定必须和这里同一个数，
// 否则积压指标会和实际放弃行为分叉（与 GIFT_CARD_MAX_ATTEMPTS 同理）。
export const VERIFICATION_CARD_MAX_ATTEMPTS = 36;
const VERIFICATION_CARD_BATCH = 50;

type CircleInvitationNotificationData = {
  toUserID: string;
  fromUserID: string;
  type:
    | 'CIRCLE_VERIFICATION_REQUESTED'
    | 'CIRCLE_INVITATION_APPROVED'
    | 'CIRCLE_INVITATION_REJECTED'
    | 'CIRCLE_ADMIN_OVERRIDE_APPROVED';
  fromCircleID: string;
  fromInvitationID: string;
};

// Single include shape reused by loadInvitation and the list queries so the
// list endpoints can hydrate in one round-trip instead of N+1. Narrowed to the
// columns toInvitationDto and assertCanViewInvitation read — `true` here would
// pull every column of the circle and of each of the ~12 joined users.
const INVITATION_USER_SELECT = {
  id: true,
  nickname: true,
  avatarUrl: true,
  accountId: true,
} as const;

const INVITATION_INCLUDE = {
  circle: { select: { name: true } },
  applicant: { select: INVITATION_USER_SELECT },
  inviter: { select: INVITATION_USER_SELECT },
  verifiers: {
    select: {
      id: true,
      verifierID: true,
      status: true,
      respondedAt: true,
      verifier: { select: INVITATION_USER_SELECT },
    },
    orderBy: { createdAt: 'asc' },
  },
} as const;

@Injectable()
export class CircleInvitationService {
  private readonly logger = new Logger(CircleInvitationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
    private readonly privacySettings: PrivacySettingsService,
    private readonly notificationService: NotificationService,
    private readonly admissionPolicy: CircleAdmissionPolicy,
    private readonly memberLock: CircleMemberLockService,
    private readonly chatCircleSync: ChatCircleSyncService,
    private readonly chatService: ChatService,
    private readonly chatMessages: ChatSystemMessageService,
  ) {}

  /**
   * 激活提交后立刻触发一次幂等座位同步,新成员不必等 ≤1min 的对账才拿到
   * 会话与消息。
   *
   * 失败必须排进对账的重试队列,不能只记日志:对账扫的是
   * `CircleMember.updatedAt` 的 2 分钟窗口,一次超过两分钟的数据库故障过后,
   * 这次激活早已滑出窗口 —— 没有任何机制会回来补,新成员的聊天座位就一直缺着。
   */
  private syncCircleSeatsSoon(circleID: string): void {
    void this.chatCircleSync
      .ensureCircleConversation(circleID)
      .catch((error) => {
        this.chatCircleSync.scheduleRetry(circleID);
        this.logger.warn(
          `post-admission seat sync failed circle=${circleID} (queued for retry): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  async invite(
    inviterId: string,
    applicantId: string,
    circleId: string,
  ): Promise<InvitationDto> {
    // Pass real friendship status: a FRIENDS_ONLY invite permission must let
    // friends through. Hardcoding false here would collapse FRIENDS_ONLY into
    // NONE and block invites even from friends.
    const inviterIsFriend = await this.areFriends(inviterId, applicantId);
    const canInviteApplicant =
      await this.privacySettings.canBeInvitedToGroupOrCircle(
        applicantId,
        inviterIsFriend,
      );
    if (!canInviteApplicant) {
      throw new ForbiddenException({
        message: 'User does not allow circle invites',
        errorCode: CircleInvitationErrorCode.NotAllowed,
      });
    }

    // 6. Create invitation + auto-approve inviter as first verifier
    const invitation = await this.runInvitationTransaction(async (tx) => {
      // CircleInvitation has no DB-level unique constraint, so serialize
      // concurrent invites for the same (circle, applicant) pair with a
      // transaction-scoped advisory lock, then re-check inside the lock.
      await this.memberLock.lock(tx, circleId, [inviterId, applicantId]);

      const [inviterMembership, lockedMembership] = await Promise.all([
        tx.circleMember.findUnique({
          where: {
            userID_circleID: { userID: inviterId, circleID: circleId },
          },
        }),
        tx.circleMember.findUnique({
          where: {
            userID_circleID: { userID: applicantId, circleID: circleId },
          },
        }),
      ]);
      if (!inviterMembership || inviterMembership.status !== 'ACTIVE') {
        throw new ForbiddenException({
          message: 'You must be an active member to invite others',
          errorCode: CircleInvitationErrorCode.InviterNotMember,
        });
      }
      if (lockedMembership?.status === 'ACTIVE') {
        throw new ConflictException({
          message: 'User is already a member of this circle',
          errorCode: CircleErrorCode.AlreadyMember,
        });
      }
      // applicantId 是被邀请人，任何拒绝原因都会回给 inviter —— 用第三方视角
      // 调用，避免把对方的加入额度状态泄露给邀请人。
      await this.admissionPolicy.assertCanApply(tx, circleId, applicantId, {
        actor: 'third-party',
      });

      const existingInvitation = await tx.circleInvitation.findFirst({
        where: {
          circleID: circleId,
          applicantID: applicantId,
          status: 'PENDING',
        },
      });
      if (existingInvitation) {
        throw new ConflictException({
          message: 'There is already a pending invitation for this user',
          errorCode: CircleInvitationErrorCode.AlreadyPending,
        });
      }

      const created = await tx.circleInvitation.create({
        data: {
          circleID: circleId,
          applicantID: applicantId,
          inviterID: inviterId,
          approvedCount: 1,
        },
        include: {
          circle: true,
          applicant: true,
          inviter: true,
        },
      });

      await tx.circleInvitationVerifier.create({
        data: {
          invitationID: created.id,
          verifierID: inviterId,
          addedByID: inviterId,
          status: 'APPROVED',
          respondedAt: new Date(),
        },
      });

      return created;
    });

    return this.fetchInvitationDto(invitation.id);
  }

  async addVerifier(
    callerId: string,
    invitationId: string,
    verifierId: string,
  ): Promise<void> {
    const notificationData = await this.runInvitationTransaction(async (tx) => {
      const application = await tx.circleInvitation.findUnique({
        where: { id: invitationId },
        select: { circleID: true, applicantID: true },
      });
      if (!application) {
        throw new NotFoundException({
          message: 'Invitation not found',
          errorCode: CircleInvitationErrorCode.NotFound,
        });
      }
      await this.memberLock.lock(tx, application.circleID, [
        callerId,
        verifierId,
      ]);

      const [invitation, membership] = await Promise.all([
        tx.circleInvitation.findUnique({
          where: { id: invitationId },
          include: { verifiers: true },
        }),
        tx.circleMember.findUnique({
          where: {
            userID_circleID: {
              userID: verifierId,
              circleID: application.circleID,
            },
          },
        }),
      ]);
      if (!invitation) {
        throw new NotFoundException({
          message: 'Invitation not found',
          errorCode: CircleInvitationErrorCode.NotFound,
        });
      }

      // Only the applicant can add verifiers
      if (invitation.applicantID !== callerId) {
        throw new ForbiddenException({
          message: 'Only the applicant can add verifiers',
          errorCode: CircleInvitationErrorCode.ApplicantOnly,
        });
      }
      if (invitation.status !== 'PENDING') {
        throw new BadRequestException({
          message: 'Invitation is no longer pending',
          errorCode: CircleInvitationErrorCode.NotPending,
        });
      }

      if (!membership || membership.status !== 'ACTIVE') {
        throw new BadRequestException({
          message: '验证人必须是本圈子的活跃成员，请更换验证人再尝试',
          errorCode: CircleInvitationErrorCode.VerifierNotMember,
        });
      }

      const existingVerifier = invitation.verifiers.find(
        (verifier) => verifier.verifierID === verifierId,
      );
      if (existingVerifier) {
        throw new ConflictException({
          message: 'This user is already a verifier',
          errorCode: CircleInvitationErrorCode.AlreadyVerifier,
        });
      }

      const activeSlots = invitation.verifiers.filter(
        (verifier) => verifier.status !== 'REJECTED',
      ).length;
      if (activeSlots >= invitation.requiredCount) {
        throw new BadRequestException({
          message: 'All verification slots are filled',
          errorCode: CircleInvitationErrorCode.SlotsFilled,
        });
      }

      await tx.circleInvitationVerifier.create({
        data: {
          invitationID: invitationId,
          verifierID: verifierId,
          addedByID: callerId,
          status: 'PENDING',
        },
      });

      return {
        toUserID: verifierId,
        fromUserID: callerId,
        type: 'CIRCLE_VERIFICATION_REQUESTED' as const,
        fromCircleID: invitation.circleID,
        fromInvitationID: invitationId,
      };
    });

    await this.createAndBroadcastInvitationNotification(notificationData);
    // 同转账卡:席位与站内通知都已提交,发卡不该再挡住响应。挂住的话客户端超时
    // 重试会撞 AlreadyVerifier(「加不进去也退不掉」),而补偿任务要等这个请求
    // 被放弃才轮得到。脱钩,失败/超时都由补偿任务按 cardDeliveredAt 兜。
    void this.issueVerificationCard({
      invitationId,
      circleId: notificationData.fromCircleID,
      // 上面的 ApplicantOnly 检查已经保证 callerId 就是申请人本人。
      applicantId: callerId,
      verifierId,
    });
  }

  /**
   * 验证邀请卡片:席位提交之后由服务端签发给验证人。
   *
   * 为什么不是客户端发:verification-card 断言的是「这个人被邀请当验证人」这个
   * 服务端事实,客户端能发就等于能凭空捏造它 —— 所以它在 SERVER_MESSAGE_TYPES 里,
   * 客户端发一律被 validateSendPayload 拒。SelectVerifierScreen 以前正是这么发的,
   * 失败还被 best-effort 的 catch 吞掉,于是这张卡从来没送达过。
   *
   * 为什么在事务外:insertServerMessage 自带事务并在成功后广播。放进邀请事务里,
   * 一次回滚就等于把一条并不存在的验证请求广播给了对方。
   *
   * 为什么失败不抛:席位已经落库。为一张发不出去的卡把请求判失败,申请人会重试,
   * 而重试撞 @@unique([invitationID, verifierID]) → AlreadyVerifier 冲突,
   * 表现成「加不进去也退不掉」。卡片是站内通知之外的第二条通道,可降级 ——
   * 与本类其它提交后副作用(见 createAndBroadcastInvitationNotification)同一取舍。
   *
   * clientMessageId 取 (invitationId, verifierId),与
   * CircleInvitationVerifier 的唯一约束同源:一个邀请里同一个验证人只有一席,
   * 卡片也就只该有一张;重试撞
   * (conversationID, senderID, clientMessageId) 唯一约束时合并,不重复广播。
   */
  private async issueVerificationCard(params: {
    invitationId: string;
    circleId: string;
    applicantId: string;
    verifierId: string;
  }): Promise<void> {
    try {
      // 名字只是卡面文案 —— 取不到就留空,卡片的实际价值是那个 invitationId 深链。
      const [circle, applicant] = await Promise.all([
        this.prisma.circle.findUnique({
          where: { id: params.circleId },
          select: { name: true },
        }),
        this.prisma.user.findUnique({
          where: { id: params.applicantId },
          select: { nickname: true },
        }),
      ]);
      await this.deliverVerificationCard({
        invitationId: params.invitationId,
        applicantId: params.applicantId,
        verifierId: params.verifierId,
        circleName: circle?.name ?? '',
        applicantName: applicant?.nickname ?? '',
      });
      // 置位是补偿任务的唯一判据 —— 只有真送出去了才置。
      await this.settleVerificationCard({
        invitationID: params.invitationId,
        verifierID: params.verifierId,
      });
    } catch (error) {
      if (this.isTerminalDeliveryRefusal(error)) {
        // 隐私设置在正确地生效,不是故障 —— 终结这一席,别让补偿任务反复重试。
        await this.settleVerificationCard({
          invitationID: params.invitationId,
          verifierID: params.verifierId,
        }).catch(() => undefined);
        this.logger.log(
          `verification card not delivered (peer does not accept it) invitation=${params.invitationId} verifier=${params.verifierId}`,
        );
        return;
      }
      this.logger.warn(
        `verification card issuance failed invitation=${params.invitationId} verifier=${params.verifierId}, leaving it to the sweep: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 卡片投递被**终局**拒绝(而不是瞬时故障)。
   *
   * 对方关了「接收陌生人消息」、拉黑了申请人、账号已注销 —— 这些重试一万次都
   * 不会变。按失败处理会白烧 12 次尝试,最后还打一条「永久丢失、需人工介入」的
   * error 日志,而这其实是**隐私设置在正确地生效**。终局拒绝直接把这一席标成
   * 「不再欠卡」:验证人照样能从站内通知与「我的待验证」列表看到这条请求。
   */
  private isTerminalDeliveryRefusal(error: unknown): boolean {
    return (
      error instanceof ForbiddenException ||
      error instanceof NotFoundException ||
      error instanceof BadRequestException
    );
  }

  /** 这一席不再欠卡(已送达,或按隐私设置不投)—— 补偿任务据此不再捡它。 */
  private async settleVerificationCard(where: {
    invitationID?: string;
    verifierID?: string;
    id?: string;
  }): Promise<void> {
    await this.prisma.circleInvitationVerifier.updateMany({
      where,
      data: { cardDeliveredAt: new Date() },
    });
  }

  /** 卡片投递本体(inline 签发与补偿任务共用,保证两条路径同键同形状)。 */
  private async deliverVerificationCard(card: {
    invitationId: string;
    applicantId: string;
    verifierId: string;
    circleName: string;
    applicantName: string;
  }): Promise<void> {
    // **必须走交互式解析**,不能用结算专用那条(review P1)。
    //
    // 转账卡能用结算解析,是因为 sendGift 只在好友之间成立、且钱已经划走 ——
    // 既成事实的回执。加验证人不同:验证人只需要是圈子活跃成员,**不需要是好友**,
    // 而这一步是申请人主动挑人触发的。用结算解析会绕过对方的「接收陌生人消息」
    // 开关直接建出一个正常的 DIRECT 会话 —— 而那道闸全仓只在建会话时查一次,
    // 发送路径永不复查(见 chat.service 里那段注释:「建完会话就能立刻 socket
    // 发消息」)。于是 POST /circle-invitation/:id/add-verifier 就成了任何人
    // 强开私聊通道的入口。
    //
    // 交互式解析会照常过拉黑与陌生人开关;被拒是**终局**,由调用方按终局处理,
    // 不进重试(见 issueVerificationCard / sweep 的 isTerminalDeliveryRefusal)。
    const conversation = await this.chatService.getOrCreateDirectConversation(
      card.applicantId,
      card.verifierId,
    );
    const conversationId = conversation.id;
    await this.chatMessages.insertServerMessage(conversationId, {
      senderID: card.applicantId,
      type: 'verification-card',
      content: {
        invitationId: card.invitationId,
        circleName: card.circleName,
        applicantName: card.applicantName,
      },
      clientMessageId: `verification_card_${card.invitationId}_${card.verifierId}`,
      push: true,
    });
  }

  /**
   * 验证卡片补偿(review 反馈)。
   *
   * inline 签发跑在席位事务**提交之后**,中间那一小段(圈子/用户查询、会话解析、
   * 消息写入)任何一步抖动都会让卡片丢掉 —— 而席位已经落库,申请人重试会撞
   * @@unique([invitationID, verifierID]) 变成 AlreadyVerifier,「加不进去也退不掉」。
   * 这一轮把漏掉的补回来。
   *
   * 与 GiftCardOutboxProcessor 同型:先抢占后外呼(条件 updateMany 抢到这一轮的
   * 投递权才发 —— 多副本同时扫表时输家 count=0 直接跳过);attempts 先记账,
   * 所以「HTTP 超时但对端已收下」也算一次尝试;clientMessageId 与 inline 同键,
   * 重复投递在 (conversationID, senderID, clientMessageId) 唯一约束上合并。
   *
   * 不复用 reconcileApprovedInvitations:那条是把票数够了的邀请落成 APPROVED,
   * 与卡片投递没有共享的查询或事务,塞进去只会让两件事互相拖慢、失败互相污染。
   */
  @TrackedCron(CronExpression.EVERY_5_MINUTES, 'verification_card_outbox')
  async sweepUndeliveredVerificationCards(
    now: Date = new Date(),
  ): Promise<number> {
    const seats = await this.prisma.circleInvitationVerifier.findMany({
      where: {
        // 只有还没表态的验证人需要这张邀请卡。这条同时挡掉两类行:
        // 1. invite() 里把邀请人自动记成 APPROVED 的那一席 —— 它从来不需要卡,
        //    没有这条过滤会给每个邀请人补一张凭空出现的验证邀请;
        // 2. 已经通过站内通知/待验证列表表过态的人 —— 卡片对他们已无意义。
        status: 'PENDING',
        // 父邀请也必须还在 PENDING。adminApprove / reconcileApprovedInvitations
        // 把邀请落成 ADMIN_APPROVED / APPROVED 时**不动席位行** —— 只看席位状态的话,
        // 补偿任务会补出一张过期卡,验证人点进去只会拿到 NotPending。
        invitation: { is: { status: 'PENDING' } },
        cardDeliveredAt: null,
        cardAttempts: { lt: VERIFICATION_CARD_MAX_ATTEMPTS },
        // 宽限期:inline 签发可能还在飞,立刻补投等于和它自己抢。
        createdAt: {
          lt: new Date(now.getTime() - VERIFICATION_CARD_GRACE_MS),
        },
      },
      orderBy: { createdAt: 'asc' },
      take: VERIFICATION_CARD_BATCH,
      include: {
        invitation: {
          select: {
            applicantID: true,
            circle: { select: { name: true } },
            applicant: { select: { nickname: true } },
          },
        },
      },
    });

    let delivered = 0;
    for (const seat of seats) {
      // 抢占必须把资格条件一起复查,而不是只 CAS attempts:扫表与抢占之间
      // respond / adminApprove / reconcile 都可能把席位或父邀请落成终态,
      // 只按快照发的话就补出一张点进去只会 NotPending 的过期卡。
      const claimed = await this.prisma.circleInvitationVerifier.updateMany({
        where: {
          id: seat.id,
          status: 'PENDING',
          invitation: { is: { status: 'PENDING' } },
          cardDeliveredAt: null,
          cardAttempts: seat.cardAttempts,
        },
        data: { cardAttempts: { increment: 1 } },
      });
      if (claimed.count === 0) continue;
      try {
        await this.deliverVerificationCard({
          invitationId: seat.invitationID,
          applicantId: seat.invitation.applicantID,
          verifierId: seat.verifierID,
          circleName: seat.invitation.circle?.name ?? '',
          applicantName: seat.invitation.applicant?.nickname ?? '',
        });
        await this.settleVerificationCard({ id: seat.id });
        delivered += 1;
      } catch (error) {
        if (this.isTerminalDeliveryRefusal(error)) {
          await this.settleVerificationCard({ id: seat.id }).catch(
            () => undefined,
          );
          this.logger.log(
            `verification card not delivered (peer does not accept it) invitation=${seat.invitationID} verifier=${seat.verifierID}`,
          );
          continue;
        }
        const attemptsNow = seat.cardAttempts + 1;
        if (attemptsNow >= VERIFICATION_CARD_MAX_ATTEMPTS) {
          // 打光后这行被查询永久排除 —— 用 error 级日志把「卡片永久丢失」暴露
          // 出来(重投安全,同 clientMessageId:
          // UPDATE "CircleInvitationVerifier" SET "cardAttempts"=0)。
          this.logger.error(
            `verification card PERMANENTLY failed after ${attemptsNow} attempts ` +
              `invitation=${seat.invitationID} verifier=${seat.verifierID}`,
          );
        } else {
          this.logger.warn(
            `verification card sweep failed invitation=${seat.invitationID} verifier=${seat.verifierID}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    return delivered;
  }

  async respond(
    verifierId: string,
    invitationId: string,
    approve: boolean,
  ): Promise<void> {
    const result = await this.runInvitationTransaction(async (tx) => {
      const application = await tx.circleInvitation.findUnique({
        where: { id: invitationId },
        select: { circleID: true, applicantID: true },
      });
      if (!application) {
        throw new NotFoundException({
          message: 'Invitation not found',
          errorCode: CircleInvitationErrorCode.NotFound,
        });
      }
      await this.memberLock.lock(tx, application.circleID, [
        verifierId,
        application.applicantID,
      ]);

      const [verifierRecord, invitation] = await Promise.all([
        tx.circleInvitationVerifier.findFirst({
          where: {
            invitationID: invitationId,
            verifierID: verifierId,
            status: 'PENDING',
          },
        }),
        tx.circleInvitation.findUnique({
          where: { id: invitationId },
          include: { circle: true },
        }),
      ]);
      if (!verifierRecord) {
        throw new NotFoundException({
          message: 'No pending verification found for you',
          errorCode: CircleInvitationErrorCode.NoPendingVerification,
        });
      }
      if (!invitation || invitation.status !== 'PENDING') {
        throw new BadRequestException({
          message: 'Invitation is no longer pending',
          errorCode: CircleInvitationErrorCode.NotPending,
        });
      }

      // Leaving or being removed from the circle deletes the membership but
      // leaves the verifier row behind, so eligibility is re-checked at vote
      // time rather than trusting the check made when the slot was assigned.
      const verifierMembership = await tx.circleMember.findUnique({
        where: {
          userID_circleID: {
            userID: verifierId,
            circleID: invitation.circleID,
          },
        },
      });
      if (!verifierMembership || verifierMembership.status !== 'ACTIVE') {
        throw new ForbiddenException({
          message: '验证人必须是本圈子的活跃成员',
          errorCode: CircleInvitationErrorCode.VerifierNotMember,
        });
      }

      await tx.circleInvitationVerifier.update({
        where: { id: verifierRecord.id },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          respondedAt: new Date(),
        },
      });

      if (!approve) {
        return {
          admission: null,
          notificationData: {
            toUserID: invitation.applicantID,
            fromUserID: verifierId,
            type: 'CIRCLE_INVITATION_REJECTED' as const,
            fromCircleID: invitation.circleID,
            fromInvitationID: invitationId,
          },
        };
      }

      const updatedRows = await tx.circleInvitation.updateMany({
        where: { id: invitationId, status: 'PENDING' },
        data: { approvedCount: { increment: 1 } },
      });
      if (updatedRows.count === 0) {
        throw new BadRequestException({
          message: 'Invitation is no longer pending',
          errorCode: CircleInvitationErrorCode.NotPending,
        });
      }

      const updatedInvitation = await tx.circleInvitation.findUnique({
        where: { id: invitationId },
        include: { circle: true },
      });
      if (!updatedInvitation) {
        throw new NotFoundException({
          message: 'Invitation not found',
          errorCode: CircleInvitationErrorCode.NotFound,
        });
      }

      if (updatedInvitation.approvedCount < updatedInvitation.requiredCount) {
        return { admission: null, notificationData: null };
      }

      const finalized = await tx.circleInvitation.updateMany({
        where: { id: invitationId, status: 'PENDING' },
        data: { status: 'APPROVED' },
      });
      if (finalized.count === 0) {
        return { admission: null, notificationData: null };
      }

      // 审批人（担保成员）读到的错误说的是申请人的额度，不是自己的。
      const admitted = await this.admissionPolicy.activateMembers(
        tx,
        updatedInvitation.circleID,
        [updatedInvitation.applicantID],
        { locksHeld: true, actor: 'third-party' },
      );

      return {
        admission:
          admitted.length > 0
            ? {
                applicantId: updatedInvitation.applicantID,
                circleID: updatedInvitation.circleID,
                groupID: updatedInvitation.circle.groupID,
              }
            : null,
        notificationData: {
          toUserID: updatedInvitation.applicantID,
          fromUserID: verifierId,
          type: 'CIRCLE_INVITATION_APPROVED' as const,
          fromCircleID: updatedInvitation.circleID,
          fromInvitationID: invitationId,
        },
      };
    });

    if (result.admission) {
      this.syncCircleSeatsSoon(result.admission.circleID);
    }

    const notificationTarget = await this.prisma.circleInvitation.findUnique({
      where: { id: invitationId },
      select: { applicantID: true, circleID: true },
    });

    if (notificationTarget?.applicantID) {
      if (result.notificationData) {
        await this.createAndBroadcastInvitationNotification(
          result.notificationData,
        );
      }
      this.realtimeService.broadcastCircleInvitationReviewed(
        notificationTarget.applicantID,
        {
          invitationId,
          circleId: notificationTarget.circleID,
          status: approve ? 'APPROVED' : 'REJECTED',
        },
      );
    }
  }

  async adminApprove(adminId: string, invitationId: string): Promise<void> {
    const invitation = await this.prisma.circleInvitation.findUnique({
      where: { id: invitationId },
      select: { circleID: true },
    });
    if (!invitation) {
      throw new NotFoundException({
        message: 'Invitation not found',
        errorCode: CircleInvitationErrorCode.NotFound,
      });
    }

    const result = await this.runInvitationTransaction(async (tx) => {
      const application = await tx.circleInvitation.findUnique({
        where: { id: invitationId },
        select: { circleID: true, applicantID: true },
      });
      if (!application) {
        throw new NotFoundException({
          message: 'Invitation not found',
          errorCode: CircleInvitationErrorCode.NotFound,
        });
      }
      await this.memberLock.lock(tx, application.circleID, [
        adminId,
        application.applicantID,
      ]);

      const [pendingInvitation, membership] = await Promise.all([
        tx.circleInvitation.findUnique({
          where: { id: invitationId },
          include: { circle: true },
        }),
        tx.circleMember.findUnique({
          where: {
            userID_circleID: {
              userID: adminId,
              circleID: application.circleID,
            },
          },
        }),
      ]);
      if (!pendingInvitation) {
        throw new NotFoundException({
          message: 'Invitation not found',
          errorCode: CircleInvitationErrorCode.NotFound,
        });
      }
      if (pendingInvitation.status !== 'PENDING') {
        throw new BadRequestException({
          message: 'Invitation is no longer pending',
          errorCode: CircleInvitationErrorCode.NotPending,
        });
      }
      if (
        !membership ||
        membership.status !== 'ACTIVE' ||
        (membership.role !== 'OWNER' && membership.role !== 'ADMIN')
      ) {
        throw new ForbiddenException({
          message: 'Only circle owner or admin can override',
          errorCode: CircleInvitationErrorCode.OwnerAdminOnly,
        });
      }

      const finalized = await tx.circleInvitation.updateMany({
        where: { id: invitationId, status: 'PENDING' },
        data: { status: 'ADMIN_APPROVED' },
      });
      if (finalized.count === 0) {
        return { admission: null, notificationData: null };
      }

      // 同上：圈主 / 管理员强制通过，错误回给操作者而不是申请人。
      const admitted = await this.admissionPolicy.activateMembers(
        tx,
        pendingInvitation.circleID,
        [pendingInvitation.applicantID],
        { locksHeld: true, actor: 'third-party' },
      );

      return {
        admission:
          admitted.length > 0
            ? {
                applicantId: pendingInvitation.applicantID,
                circleID: pendingInvitation.circleID,
                groupID: pendingInvitation.circle.groupID,
              }
            : null,
        notificationData: {
          toUserID: pendingInvitation.applicantID,
          fromUserID: adminId,
          type: 'CIRCLE_ADMIN_OVERRIDE_APPROVED' as const,
          fromCircleID: pendingInvitation.circleID,
          fromInvitationID: invitationId,
        },
      };
    });

    if (result.admission) {
      this.syncCircleSeatsSoon(result.admission.circleID);
    }

    const notificationTarget = await this.prisma.circleInvitation.findUnique({
      where: { id: invitationId },
      select: { applicantID: true },
    });

    if (notificationTarget?.applicantID) {
      if (result.notificationData) {
        await this.createAndBroadcastInvitationNotification(
          result.notificationData,
        );
      }
      this.realtimeService.broadcastCircleInvitationReviewed(
        notificationTarget.applicantID,
        {
          invitationId,
          circleId: invitation.circleID,
          status: 'ADMIN_APPROVED',
        },
      );
    }
  }

  /**
   * Repairs invitations that crossed the approval threshold while the
   * request transaction was interrupted. This intentionally uses the same
   * admission transaction and side effects as a verifier approval, so a
   * restart cannot leave a permanently pending invitation with a full set of
   * approvals.
   */
  @TrackedCron(
    CronExpression.EVERY_5_MINUTES,
    'circle_invitation_reconciliation',
  )
  async reconcileApprovedInvitations(): Promise<number> {
    const candidates = await this.prisma.$queryRaw<
      Array<{ id: string; circleID: string; applicantID: string }>
    >`
      SELECT "id", "circleID", "applicantID"
      FROM "CircleInvitation"
      WHERE "status" = 'PENDING'
        AND "approvedCount" >= "requiredCount"
      ORDER BY "updatedAt" ASC, "id" ASC
      LIMIT 100
    `;
    let finalizedCount = 0;
    for (const candidate of candidates) {
      try {
        const result = await this.runInvitationTransaction(async (tx) => {
          await this.memberLock.lock(tx, candidate.circleID, [
            candidate.applicantID,
          ]);

          const invitation = await tx.circleInvitation.findUnique({
            where: { id: candidate.id },
            include: { circle: true },
          });
          if (
            !invitation ||
            invitation.status !== 'PENDING' ||
            invitation.approvedCount < invitation.requiredCount
          ) {
            return null;
          }
          const changed = await tx.circleInvitation.updateMany({
            where: { id: invitation.id, status: 'PENDING' },
            data: { status: 'APPROVED' },
          });
          if (changed.count === 0) return null;
          // 后台补偿任务：异常只进日志、没有接收方，保留默认的详细错误码，
          // 这样 catch 里记下的是「哪条上限挡住了」而不是一句中性话。
          const admitted = await this.admissionPolicy.activateMembers(
            tx,
            invitation.circleID,
            [invitation.applicantID],
            { locksHeld: true },
          );
          return {
            admitted: admitted.length > 0,
            applicantId: invitation.applicantID,
            circleId: invitation.circleID,
            groupID: invitation.circle.groupID,
            notificationData: {
              toUserID: invitation.applicantID,
              fromUserID: invitation.inviterID,
              type: 'CIRCLE_INVITATION_APPROVED' as const,
              fromCircleID: invitation.circleID,
              fromInvitationID: invitation.id,
            },
          };
        });
        if (!result) continue;
        finalizedCount += 1;
        if (result.admitted) {
          this.syncCircleSeatsSoon(result.circleId);
        }
        await this.createAndBroadcastInvitationNotification(
          result.notificationData,
        );
        this.realtimeService.broadcastCircleInvitationReviewed(
          result.applicantId,
          {
            invitationId: candidate.id,
            circleId: result.circleId,
            status: 'APPROVED',
          },
        );
      } catch (error) {
        this.logger.warn(
          `Circle invitation reconciliation failed for ${candidate.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // Transient conflicts are already retried inside the transaction, so
        // reaching here means a deterministic block (full circle / unmet
        // restriction / missing side-effect). Left untouched, such rows keep
        // the oldest `updatedAt` and re-fill the `ORDER BY updatedAt ASC LIMIT
        // 100` window every run, starving admissible invitations. Touch the row
        // so it rotates to the back of the queue; a still-blocked candidate
        // simply retries on a later cycle instead of monopolizing the batch.
        try {
          await this.prisma.circleInvitation.updateMany({
            where: { id: candidate.id, status: 'PENDING' },
            data: { status: 'PENDING' },
          });
        } catch (bumpError) {
          this.logger.warn(
            `Failed to defer reconciliation row ${candidate.id}: ${
              bumpError instanceof Error ? bumpError.message : String(bumpError)
            }`,
          );
        }
      }
    }
    return finalizedCount;
  }

  async getInvitationForViewer(
    viewerId: string,
    invitationId: string,
  ): Promise<InvitationDto> {
    const inv = await this.loadInvitation(invitationId);
    await this.assertCanViewInvitation(viewerId, inv);
    return this.toInvitationDto(inv);
  }

  private async fetchInvitationDto(
    invitationId: string,
  ): Promise<InvitationDto> {
    const inv = await this.loadInvitation(invitationId);
    return this.toInvitationDto(inv);
  }

  async getMyPendingVerifications(
    userId: string,
    query: InvitationListQueryDto = new InvitationListQueryDto(),
  ): Promise<InvitationDto[]> {
    const whereBase: Prisma.CircleInvitationWhereInput = {
      status: 'PENDING',
      verifiers: { some: { verifierID: userId, status: 'PENDING' } },
    };
    const cursorWhere = await this.pendingInvitationCursorWhere(query.cursor, {
      verifiers: { some: { verifierID: userId } },
    });
    // Single hydrated query — no N+1 over individual invitation loads.
    const invitations = await this.prisma.circleInvitation.findMany({
      where: cursorWhere ? { AND: [whereBase, cursorWhere] } : whereBase,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: INVITATION_INCLUDE,
      take: query.limit ?? DEFAULT_INVITATION_LIST_LIMIT,
    });

    return invitations.map((inv) => this.toInvitationDto(inv));
  }

  async getMyApplications(
    userId: string,
    query: InvitationListQueryDto = new InvitationListQueryDto(),
  ): Promise<InvitationDto[]> {
    const whereBase: Prisma.CircleInvitationWhereInput = {
      applicantID: userId,
      status: 'PENDING',
    };
    const cursorWhere = await this.pendingInvitationCursorWhere(query.cursor, {
      applicantID: userId,
    });
    const invitations = await this.prisma.circleInvitation.findMany({
      // Settled applications are history the caller cannot act on; only the
      // in-flight ones drive the "verify me" entry point.
      where: cursorWhere ? { AND: [whereBase, cursorWhere] } : whereBase,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: INVITATION_INCLUDE,
      take: query.limit ?? DEFAULT_INVITATION_LIST_LIMIT,
    });

    return invitations.map((inv) => this.toInvitationDto(inv));
  }

  async getPendingInvitationsForCircle(
    adminId: string,
    circleId: string,
    query: InvitationListQueryDto = new InvitationListQueryDto(),
  ): Promise<InvitationDto[]> {
    // Verify admin role
    const membership = await this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID: adminId, circleID: circleId } },
    });
    if (
      !membership ||
      membership.status !== 'ACTIVE' ||
      (membership.role !== 'OWNER' && membership.role !== 'ADMIN')
    ) {
      throw new ForbiddenException({
        message: 'Only circle owner or admin can view',
        errorCode: CircleInvitationErrorCode.OwnerAdminOnly,
      });
    }

    const whereBase: Prisma.CircleInvitationWhereInput = {
      circleID: circleId,
      status: 'PENDING',
    };
    const cursorWhere = await this.pendingInvitationCursorWhere(query.cursor, {
      circleID: circleId,
    });
    const invitations = await this.prisma.circleInvitation.findMany({
      where: cursorWhere ? { AND: [whereBase, cursorWhere] } : whereBase,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: INVITATION_INCLUDE,
      take: query.limit ?? DEFAULT_INVITATION_LIST_LIMIT,
    });

    return invitations.map((inv) => this.toInvitationDto(inv));
  }

  private async pendingInvitationCursorWhere(
    cursor: string | undefined,
    scope: Prisma.CircleInvitationWhereInput,
  ): Promise<Prisma.CircleInvitationWhereInput | undefined> {
    if (!cursor) {
      return undefined;
    }

    const anchor = await this.prisma.circleInvitation.findFirst({
      where: { id: cursor, ...scope },
      select: { createdAt: true },
    });
    if (!anchor) {
      throw new BadRequestException({
        message: 'Invalid invitation cursor',
        errorCode: CircleInvitationErrorCode.InvalidCursor,
      });
    }

    return feedCursorWhere({ createdAt: anchor.createdAt, id: cursor });
  }

  private async loadInvitation(invitationId: string) {
    const inv = await this.prisma.circleInvitation.findUnique({
      where: { id: invitationId },
      include: INVITATION_INCLUDE,
    });
    if (!inv) {
      throw new NotFoundException({
        message: 'Invitation not found',
        errorCode: CircleInvitationErrorCode.NotFound,
      });
    }
    return inv;
  }

  private toInvitationDto(
    inv: Awaited<ReturnType<CircleInvitationService['loadInvitation']>>,
  ): InvitationDto {
    return {
      id: inv.id,
      circleId: inv.circleID,
      circleName: inv.circle.name,
      applicant: {
        id: inv.applicant.id,
        nickname: inv.applicant.nickname,
        avatarUrl: inv.applicant.avatarUrl,
        accountId: inv.applicant.accountId,
      },
      inviter: {
        id: inv.inviter.id,
        nickname: inv.inviter.nickname,
        avatarUrl: inv.inviter.avatarUrl,
        accountId: inv.inviter.accountId,
      },
      requiredCount: inv.requiredCount,
      approvedCount: inv.approvedCount,
      status: inv.status,
      verifiers: inv.verifiers.map(
        (v): InvitationVerifierDto => ({
          id: v.id,
          verifier: {
            id: v.verifier.id,
            nickname: v.verifier.nickname,
            avatarUrl: v.verifier.avatarUrl,
            accountId: v.verifier.accountId,
          },
          status: v.status,
          respondedAt: v.respondedAt?.toISOString() ?? null,
        }),
      ),
      createdAt: inv.createdAt.toISOString(),
    };
  }

  private async assertCanViewInvitation(
    viewerId: string,
    invitation: Awaited<ReturnType<CircleInvitationService['loadInvitation']>>,
  ): Promise<void> {
    if (
      invitation.applicantID === viewerId ||
      invitation.inviterID === viewerId ||
      invitation.verifiers.some((verifier) => verifier.verifierID === viewerId)
    ) {
      return;
    }

    const membership = await this.prisma.circleMember.findUnique({
      where: {
        userID_circleID: { userID: viewerId, circleID: invitation.circleID },
      },
    });
    if (
      membership &&
      membership.status === 'ACTIVE' &&
      (membership.role === 'OWNER' || membership.role === 'ADMIN')
    ) {
      return;
    }

    throw new ForbiddenException({
      message: 'You are not allowed to view this invitation',
      errorCode: CircleInvitationErrorCode.ViewForbidden,
    });
  }

  private async createAndBroadcastInvitationNotification(
    data: CircleInvitationNotificationData,
  ): Promise<void> {
    try {
      const notification =
        await this.notificationService.createCircleInvitationNotification(data);
      if (!notification) return;
      await this.realtimeService.broadcastInteractionUnread(data.toUserID);
      this.realtimeService.broadcastNotificationCreated(
        data.toUserID,
        notification,
      );
    } catch (error) {
      this.logger.warn(
        `Circle invitation notification side effect failed: ${data.type} ${data.fromUserID} -> ${data.toUserID}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async runInvitationTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return runSerializableTransaction(this.prisma, operation);
  }

  private async areFriends(a: string, b: string): Promise<boolean> {
    const record = await this.prisma.friend.findFirst({
      where: {
        state: 'ACCEPTED',
        OR: [
          { userID: a, friendID: b },
          { userID: b, friendID: a },
        ],
      },
      select: { userID: true },
    });
    return record !== null;
  }
}
