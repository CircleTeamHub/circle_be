import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { QrErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatService } from 'src/chat/chat.service';
import { CircleInvitationService } from 'src/circle-invitation/circle-invitation.service';
import type { Prisma, QrToken } from 'src/generated/prisma';
import type {
  QrJoinResultDto,
  QrResolveDto,
  QrTokenDto,
  QrTokenTypeDto,
} from './qr.types';

// 微信语义:群/圈子码 7 天有效,「重新进入将更新」。剩余不足 24 小时才轮换新码,
// 不然每次打开页面都插一行令牌;旧码在自己的 7 天线内继续有效(与微信一致)。
const GROUP_CIRCLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROTATE_BELOW_REMAINING_MS = 24 * 60 * 60 * 1000;

/**
 * 二维码令牌:签发 / 解析 / 扫码加入。
 *
 * 授权模型:UUID 不是授权,令牌才是。校验一律读库(不做无状态签名),
 * 过期、撤销、签发者失权(退群/退圈)都要立刻生效:
 * - GROUP:入座即授权,签发人退群不影响已发出的码(微信语义,码属于群);
 * - CIRCLE:join 走 CircleInvitationService.invite(签发人=邀请人),签发人
 *   退圈后 InviterNotMember 自然拒绝 —— 圈码随签发者失权而失效(fail closed)。
 */
@Injectable()
export class QrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
    private readonly circleInvitation: CircleInvitationService,
  ) {}

  async issueToken(
    userId: string,
    // LOGIN 令牌住独立表（QrLoginSession），签发面只收三种实体码。
    type: Exclude<QrTokenTypeDto, 'LOGIN'>,
    targetId?: string,
  ): Promise<QrTokenDto> {
    const targetID = await this.assertCanIssue(userId, type, targetId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockTokenKey(tx, userId, type, targetID);

      const reuseHorizon = new Date(Date.now() + ROTATE_BELOW_REMAINING_MS);
      const existing = await tx.qrToken.findFirst({
        where: {
          type,
          targetID,
          issuerID: userId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: reuseHorizon } }],
        },
        orderBy: { createdAt: 'desc' },
        select: { token: true, expiresAt: true },
      });
      if (existing) {
        return {
          token: existing.token,
          type,
          expiresAt: existing.expiresAt?.toISOString() ?? null,
        };
      }

      // 192 bit 随机,URL 安全;唯一冲突概率可忽略,不做重试。
      const token = randomBytes(24).toString('base64url');
      const expiresAt =
        type === 'USER' ? null : new Date(Date.now() + GROUP_CIRCLE_TTL_MS);
      await tx.qrToken.create({
        data: { token, type, targetID, issuerID: userId, expiresAt },
      });
      return { token, type, expiresAt: expiresAt?.toISOString() ?? null };
    });
  }

  async rotateUserToken(userId: string): Promise<QrTokenDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockTokenKey(tx, userId, 'USER', userId);
      const current = await tx.qrToken.findFirst({
        where: {
          type: 'USER',
          targetID: userId,
          issuerID: userId,
          revokedAt: null,
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, token: true, createdAt: true },
      });
      // 这里刻意不做「N 秒内重复调用返回原令牌」的去重。本接口只有一个调用方:
      // 用户手动点「重置二维码」(POST tokens/rotate,文档即"撤销并重签"),而客户端
      // 随后会弹"旧二维码已失效"。用时间窗做重试幂等分不清"网络重传"和"用户第二次
      // 主动重置",后者被静默吞掉时用户会以为泄露出去的码已经作废 —— 而它还活着。
      // 真需要重试幂等应由调用方带幂等键,不能靠墙上时钟猜。
      // 历史无界增长由下面的原地更新解决,与是否去重无关。

      const token = randomBytes(24).toString('base64url');
      if (current) {
        await tx.qrToken.update({
          where: { id: current.id },
          data: { token, createdAt: new Date(), revokedAt: null },
        });
      } else {
        await tx.qrToken.create({
          data: {
            token,
            type: 'USER',
            targetID: userId,
            issuerID: userId,
            expiresAt: null,
          },
        });
      }
      return { token, type: 'USER', expiresAt: null };
    });
  }

  async resolveToken(viewerId: string, token: string): Promise<QrResolveDto> {
    // 网页扫码登录的令牌存在独立表：先查它，命中即返回 LOGIN 预览
    // （落地页据此渲染"确认登录"面板）。失效/已用与普通令牌同文案，不给探测面。
    const loginSession = await this.prisma.qrLoginSession.findUnique({
      where: { qrToken: token },
    });
    if (loginSession) {
      if (
        loginSession.status !== 'PENDING' ||
        loginSession.expiresAt.getTime() <= Date.now()
      ) {
        throw new NotFoundException({
          message: '二维码已失效',
          errorCode: QrErrorCode.Expired,
        });
      }
      return {
        type: 'LOGIN',
        targetId: loginSession.id,
        name: '',
        avatarUrl: null,
        memberCount: null,
        issuerNickname: '',
        expiresAt: loginSession.expiresAt.toISOString(),
        viewerState: 'NONE',
      };
    }

    const row = await this.requireValidToken(token);
    const issuer = await this.prisma.user.findUnique({
      where: { id: row.issuerID },
      select: { nickname: true },
    });
    const base = {
      type: row.type as QrTokenTypeDto,
      targetId: row.targetID,
      issuerNickname: issuer?.nickname ?? '',
      expiresAt: row.expiresAt?.toISOString() ?? null,
    };

    if (row.type === 'USER') {
      const user = await this.prisma.user.findUnique({
        where: { id: row.targetID },
        select: { nickname: true, avatarUrl: true, status: true },
      });
      if (!user || user.status !== 'ACTIVE') {
        throw this.invalidError();
      }
      const viewerState =
        row.targetID === viewerId
          ? 'SELF'
          : (await this.areFriends(viewerId, row.targetID))
            ? 'FRIEND'
            : 'NONE';
      return {
        ...base,
        name: user.nickname,
        avatarUrl: user.avatarUrl,
        memberCount: null,
        viewerState,
      };
    }

    if (row.type === 'GROUP') {
      const conversation = await this.prisma.chatConversation.findUnique({
        where: { id: row.targetID },
        select: { type: true, circleID: true, name: true },
      });
      if (
        !conversation ||
        conversation.type !== 'GROUP' ||
        conversation.circleID
      ) {
        throw this.invalidError();
      }
      const [seated, mySeat] = await Promise.all([
        this.prisma.chatMember.count({
          where: { conversationID: row.targetID, leftAt: null },
        }),
        this.prisma.chatMember.findFirst({
          where: {
            conversationID: row.targetID,
            userID: viewerId,
            leftAt: null,
          },
          select: { id: true },
        }),
      ]);
      // 全员退光的死群:码不再开门。
      if (seated === 0) throw this.invalidError();
      return {
        ...base,
        name: conversation.name ?? '',
        avatarUrl: null,
        memberCount: seated,
        viewerState: mySeat ? 'ALREADY_IN' : 'NONE',
      };
    }

    const circle = await this.prisma.circle.findUnique({
      where: { id: row.targetID },
      select: {
        name: true,
        avatarUrl: true,
        memberCount: true,
        deleted: true,
        adminState: true,
      },
    });
    // 非 ACTIVE 的管理态(停用/解散中/...)一律视作码已失效,新增枚举值默认拒绝。
    if (!circle || circle.deleted || circle.adminState !== 'ACTIVE') {
      throw this.invalidError();
    }
    const membership = await this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID: viewerId, circleID: row.targetID } },
      select: { status: true },
    });
    return {
      ...base,
      name: circle.name,
      avatarUrl: circle.avatarUrl,
      memberCount: circle.memberCount,
      viewerState: membership?.status === 'ACTIVE' ? 'ALREADY_IN' : 'NONE',
    };
  }

  async joinByToken(viewerId: string, token: string): Promise<QrJoinResultDto> {
    const row = await this.requireValidToken(token);

    if (row.type === 'USER') {
      // 名片码不走 join:落地页跳个人资料,加好友走 /friend/requests(带 qrToken)。
      throw new BadRequestException({
        message: '该二维码不支持此操作',
        errorCode: QrErrorCode.TypeUnsupported,
      });
    }

    if (row.type === 'GROUP') {
      const conversation = await this.chatService.joinStandaloneGroupViaQr(
        viewerId,
        row.targetID,
      );
      return {
        type: 'GROUP',
        conversationId: conversation.id,
        status: 'JOINED',
      };
    }

    // 圈子:签发人立场的邀请。快照语义(requiredVerifierCount=1 且签发人可担保)
    // 直接入圈;严格模式建担保单等验证人凑齐。策略、容量、拉黑、签发人失权
    // 都由 invite() 内的事务闸把关。
    const invitation = await this.circleInvitation.invite(
      row.issuerID,
      viewerId,
      row.targetID,
      { applicantConsented: true },
    );
    const joined =
      invitation.status === 'APPROVED' ||
      invitation.status === 'ADMIN_APPROVED';
    return {
      type: 'CIRCLE',
      circleId: row.targetID,
      status: joined ? 'JOINED' : 'PENDING',
    };
  }

  /** 名下有效令牌校验(不存在/撤销 → 404 QR_INVALID;过期 → 410 QR_EXPIRED)。 */
  private async requireValidToken(token: string): Promise<QrToken> {
    const row = token
      ? await this.prisma.qrToken.findUnique({ where: { token } })
      : null;
    if (!row || row.revokedAt !== null) {
      throw this.invalidError();
    }
    if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
      throw new GoneException({
        message: '二维码已过期,请对方重新出示',
        errorCode: QrErrorCode.Expired,
      });
    }
    return row;
  }

  private invalidError(): NotFoundException {
    return new NotFoundException({
      message: '二维码无效或已失效',
      errorCode: QrErrorCode.Invalid,
    });
  }

  private async lockTokenKey(
    tx: Prisma.TransactionClient,
    issuerId: string,
    type: QrTokenTypeDto,
    targetId: string,
  ): Promise<void> {
    const lockKey = `qr-token:${issuerId}:${type}:${targetId}`;
    // pg_advisory_xact_lock 返回 void；转成 text，避免 Prisma PG adapter
    // 在反序列化 raw void 列时抛 P2010。
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
  }

  /** 签发资格,返回归一化的 targetID。 */
  private async assertCanIssue(
    userId: string,
    type: QrTokenTypeDto,
    targetId?: string,
  ): Promise<string> {
    if (type === 'USER') {
      // 名片只能签自己的;带了别人的 id 直接拒。
      if (targetId && targetId !== userId) {
        throw this.issueForbidden();
      }
      return userId;
    }

    if (!targetId) {
      throw new BadRequestException({
        message: '缺少 targetId',
        errorCode: QrErrorCode.IssueForbidden,
      });
    }

    if (type === 'GROUP') {
      const conversation = await this.prisma.chatConversation.findUnique({
        where: { id: targetId },
        select: { type: true, circleID: true },
      });
      // 圈子群不发 GROUP 码 —— 圈子群的准入由圈子管理,发 CIRCLE 码。
      if (
        !conversation ||
        conversation.type !== 'GROUP' ||
        conversation.circleID
      ) {
        throw this.issueForbidden();
      }
      const seat = await this.prisma.chatMember.findFirst({
        where: { conversationID: targetId, userID: userId, leftAt: null },
        select: { id: true },
      });
      if (!seat) throw this.issueForbidden();
      return targetId;
    }

    const circle = await this.prisma.circle.findUnique({
      where: { id: targetId },
      select: { deleted: true, adminState: true, memberCanInvite: true },
    });
    if (!circle || circle.deleted || circle.adminState !== 'ACTIVE') {
      throw this.issueForbidden();
    }
    const membership = await this.prisma.circleMember.findUnique({
      where: { userID_circleID: { userID: userId, circleID: targetId } },
      select: { role: true, status: true },
    });
    const canInvite =
      membership?.status === 'ACTIVE' &&
      (membership.role === 'OWNER' ||
        membership.role === 'ADMIN' ||
        circle.memberCanInvite);
    if (!canInvite) throw this.issueForbidden();
    return targetId;
  }

  private issueForbidden(): ForbiddenException {
    return new ForbiddenException({
      message: '没有签发该二维码的权限',
      errorCode: QrErrorCode.IssueForbidden,
    });
  }

  private async areFriends(a: string, b: string): Promise<boolean> {
    const row = await this.prisma.friend.findFirst({
      where: {
        state: 'ACCEPTED',
        OR: [
          { userID: a, friendID: b },
          { userID: b, friendID: a },
        ],
      },
      select: { id: true },
    });
    return row !== null;
  }
}
