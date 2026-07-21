import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'crypto';
import { TempChatStatus } from 'src/generated/prisma';
import { TempChatErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import { OpenimService } from 'src/openim/openim.service';
import { LinkTokenService } from './link-token.service';
import { CreateTempChatDto } from './dto/create-temp-chat.dto';
import { JoinTempChatDto } from './dto/join-temp-chat.dto';
import { newGroupId, newGuestId } from './temp-chat.ids';

export interface CreateTempChatResult {
  id: string;
  groupId: string;
  title: string;
  maxMembers: number;
  expiresAt: string;
  shareUrl: string;
}

export interface TempChatMeta {
  title: string;
  memberCount: number;
  maxMembers: number;
  status: string;
  expiresAt: string;
  full: boolean;
}

export interface TempChatListItem {
  id: string;
  groupId: string;
  title: string;
  status: string;
  guestCount: number;
  memberCount: number;
  maxMembers: number;
  expiresAt: string;
  createdAt: string;
  endedAt: string | null;
  shareUrl: string | null;
}

@Injectable()
export class TempChatService {
  private static readonly CLEANUP_LEASE_MS = 2 * 60 * 1000;
  private readonly logger = new Logger(TempChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openim: OpenimService,
    private readonly linkToken: LinkTokenService,
    private readonly config: ConfigService,
  ) {}

  async create(
    hostUserId: string,
    dto: CreateTempChatDto,
  ): Promise<CreateTempChatResult> {
    const title = (dto.title?.trim() || '临时聊天').slice(0, 30);
    const ttlMinutes =
      dto.ttlMinutes ??
      this.config.get<number>('TEMP_CHAT_DEFAULT_TTL_MINUTES', 4320);
    const maxMembers =
      dto.maxMembers ?? this.config.get<number>('TEMP_CHAT_MAX_MEMBERS', 50);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    const groupId = newGroupId();
    // 先建群；落库失败要回滚群，避免 OpenIM 留孤儿群。
    await this.openim.createGroup(groupId, title, hostUserId, [hostUserId]);
    try {
      const row = await this.prisma.tempChat.create({
        data: { groupId, hostUserId, title, maxMembers, expiresAt },
      });
      const seconds = Math.max(
        1,
        Math.floor((expiresAt.getTime() - Date.now()) / 1000),
      );
      const token = this.linkToken.sign(row.id, seconds);
      const base = this.config.get<string>('TEMP_CHAT_WEB_BASE', '');
      return {
        id: row.id,
        groupId: row.groupId,
        title: row.title,
        maxMembers: row.maxMembers,
        expiresAt: row.expiresAt.toISOString(),
        shareUrl: `${base}/t/${token}`,
      };
    } catch (err) {
      await this.openim.dismissGroup(groupId).catch(() => undefined);
      throw err;
    }
  }

  async getByToken(token: string): Promise<TempChatMeta> {
    const { tcId } = this.linkToken.verify(token); // 抛错 → 调用方转 404
    const room = await this.prisma.tempChat.findUnique({ where: { id: tcId } });
    if (
      !room ||
      room.status !== 'ACTIVE' ||
      room.expiresAt.getTime() <= Date.now()
    ) {
      throw new GoneException({
        message: '临时聊天已结束',
        errorCode: TempChatErrorCode.Ended,
      });
    }
    const memberCount = await this.prisma.tempChatGuest.count({
      where: { tempChatId: tcId, provisioningFailedAt: null },
    });
    return {
      title: room.title,
      memberCount,
      maxMembers: room.maxMembers,
      status: room.status,
      expiresAt: room.expiresAt.toISOString(),
      full: memberCount >= room.maxMembers,
    };
  }

  async listMine(hostUserId: string): Promise<TempChatListItem[]> {
    const rows = await this.prisma.tempChat.findMany({
      where: { hostUserId },
      orderBy: [{ createdAt: 'desc' }],
      take: 200, // #108：防爆护栏
      include: {
        _count: {
          select: { guests: { where: { provisioningFailedAt: null } } },
        },
      },
    });

    const base = this.config.get<string>('TEMP_CHAT_WEB_BASE', '');
    const now = Date.now();

    return rows.map((row) => {
      const guestCount = row._count.guests;
      const remainingSeconds = Math.floor(
        (row.expiresAt.getTime() - now) / 1000,
      );
      const effectiveStatus =
        row.status === TempChatStatus.ACTIVE && remainingSeconds <= 0
          ? TempChatStatus.EXPIRED
          : row.status;
      const shareUrl =
        effectiveStatus === TempChatStatus.ACTIVE
          ? `${base}/t/${this.linkToken.sign(row.id, Math.max(1, remainingSeconds))}`
          : null;

      return {
        id: row.id,
        groupId: row.groupId,
        title: row.title,
        status: effectiveStatus,
        guestCount,
        memberCount: guestCount + 1,
        maxMembers: row.maxMembers,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
        shareUrl,
      };
    });
  }

  async join(
    token: string,
    dto: JoinTempChatDto,
  ): Promise<{
    imUserId: string;
    imToken: string;
    groupId: string;
    wsUrl: string;
    apiUrl: string;
    displayName: string;
  }> {
    const { tcId } = this.linkToken.verify(token);
    const displayName = (
      dto.displayName?.trim() || `访客${randomInt(1000, 10000)}`
    ).slice(0, 20);
    const guestImId = newGuestId();

    // 原子占座：Serializable 事务内复查房间状态 + 人数后再建 guest 行。
    // 既防并发超员，也关上「访客加入与房间销毁(teardown)同时发生」的竞态窗口
    // —— 房间状态在事务内复核，销毁后不可能再占到座。
    const { guest, room } = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`temp-chat:${tcId}`}))`;
        const room = await tx.tempChat.findUnique({ where: { id: tcId } });
        if (
          !room ||
          room.status !== 'ACTIVE' ||
          room.expiresAt.getTime() <= Date.now()
        ) {
          throw new GoneException({
            message: '临时聊天已结束',
            errorCode: TempChatErrorCode.Ended,
          });
        }
        const count = await tx.tempChatGuest.count({
          where: { tempChatId: tcId, provisioningFailedAt: null },
        });
        if (count >= room.maxMembers) {
          throw new ConflictException({
            message: '人数已满',
            errorCode: TempChatErrorCode.Full,
          });
        }
        const guest = await tx.tempChatGuest.create({
          data: { tempChatId: tcId, imUserId: guestImId, displayName },
        });
        return { guest, room };
      },
      { isolationLevel: 'Serializable' },
    );

    try {
      await this.openim.registerUser(guestImId, displayName);
      await this.openim.addGroupMembers(room.groupId, [guestImId]);
      const imToken = await this.openim.getUserToken(guestImId, 5);
      const stillActive = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`temp-chat:${tcId}`}))`;
          const current = await tx.tempChat.findUnique({
            where: { id: tcId },
            select: { status: true, expiresAt: true },
          });
          return Boolean(
            current?.status === TempChatStatus.ACTIVE &&
            current.expiresAt.getTime() > Date.now(),
          );
        },
        { isolationLevel: 'Serializable' },
      );
      if (!stillActive) {
        throw new GoneException({
          message: '临时聊天已结束',
          errorCode: TempChatErrorCode.Ended,
        });
      }
      return {
        imUserId: guestImId,
        imToken,
        groupId: room.groupId,
        wsUrl: this.config.get<string>('OPENIM_IM_WS_URL', ''),
        apiUrl: this.config.get<string>('OPENIM_IM_API_URL', ''),
        displayName,
      };
    } catch (err) {
      // 补偿：OpenIM 任一步失败，释放座位，让访客可重试。
      this.logger.warn(
        `Temp chat OpenIM join failed for guest ${guest.id}`,
        err instanceof Error ? err.stack : undefined,
      );
      await this.compensateGuest(room.groupId, guestImId, guest.id);
      if (err instanceof GoneException) throw err;
      throw new ServiceUnavailableException({
        message: '加入失败，请重试',
        errorCode: TempChatErrorCode.JoinFailed,
      });
    }
  }

  async end(hostUserId: string, id: string): Promise<{ status: string }> {
    const room = await this.prisma.tempChat.findUniqueOrThrow({
      where: { id },
    });
    if (room.hostUserId !== hostUserId) {
      throw new ForbiddenException({
        message: '只有创建者可以结束',
        errorCode: TempChatErrorCode.CreatorOnly,
      });
    }
    if (room.status !== 'ACTIVE') {
      return { status: room.status };
    }
    const finalStatus = await this.teardown(room, TempChatStatus.ENDED);
    return { status: finalStatus };
  }

  /** 解散群 + 强制访客下线 + 落库状态。幂等：仅对 ACTIVE 房调用。 */
  async teardown(
    room: { id: string; groupId: string },
    status: TempChatStatus,
  ): Promise<TempChatStatus> {
    const claim = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`temp-chat:${room.id}`}))`;
      const current = await tx.tempChat.findUnique({ where: { id: room.id } });
      if (!current) {
        return { finalStatus: status, shouldCleanup: false, guests: [] };
      }
      const finalStatus =
        current.status === TempChatStatus.ACTIVE ? status : current.status;
      const staleBefore = new Date(
        Date.now() - TempChatService.CLEANUP_LEASE_MS,
      );
      if (
        current.cleanupCompletedAt ||
        (current.cleanupLockedAt && current.cleanupLockedAt > staleBefore)
      ) {
        return { finalStatus, shouldCleanup: false, guests: [] };
      }
      const claimedAt = new Date();
      await tx.tempChat.update({
        where: { id: room.id },
        data: {
          status: finalStatus,
          endedAt: current.endedAt ?? claimedAt,
          cleanupLockedAt: claimedAt,
        },
      });
      const guests = await tx.tempChatGuest.findMany({
        where: { tempChatId: room.id, cleanedUp: false },
        select: { imUserId: true },
      });
      return {
        finalStatus,
        shouldCleanup: true,
        guests,
        claimedAt,
        groupDismissed: Boolean(current.cleanupGroupDismissedAt),
      };
    });

    if (!claim.shouldCleanup) return claim.finalStatus;

    let dismissFailure: unknown;
    if (!claim.groupDismissed) {
      let dismissed = false;
      try {
        await this.openim.dismissGroup(room.groupId);
        dismissed = true;
      } catch (error) {
        if (this.isAlreadyAbsent(error)) dismissed = true;
        else dismissFailure = error;
      }
      if (dismissed) {
        await this.prisma.tempChat.updateMany({
          where: { id: room.id, cleanupLockedAt: claim.claimedAt },
          data: { cleanupGroupDismissedAt: new Date() },
        });
      }
    }
    const guestFailures: unknown[] = [];
    const cleanupConcurrency = 10;
    for (
      let offset = 0;
      offset < claim.guests.length;
      offset += cleanupConcurrency
    ) {
      const batch = claim.guests.slice(offset, offset + cleanupConcurrency);
      const results = await Promise.allSettled(
        batch.map((guest) => this.openim.forceLogout(guest.imUserId)),
      );
      const successfulGuests: string[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          successfulGuests.push(batch[index].imUserId);
        } else {
          guestFailures.push(result.reason);
        }
      });
      if (successfulGuests.length > 0) {
        await this.prisma.tempChatGuest.updateMany({
          where: {
            tempChatId: room.id,
            imUserId: { in: successfulGuests },
          },
          data: { cleanedUp: true },
        });
      }
    }
    const cleanupSucceeded = !dismissFailure && guestFailures.length === 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.tempChat.updateMany({
        where: { id: room.id, cleanupLockedAt: claim.claimedAt },
        data: cleanupSucceeded
          ? { cleanupCompletedAt: new Date(), cleanupLockedAt: null }
          : { cleanupLockedAt: null },
      });
    });

    if (!cleanupSucceeded) {
      throw dismissFailure ?? guestFailures[0];
    }
    return claim.finalStatus;
  }

  private async compensateGuest(
    groupId: string,
    imUserId: string,
    guestId: string,
  ): Promise<void> {
    const results = await Promise.allSettled([
      this.openim.removeGroupMember(groupId, imUserId),
      this.openim.forceLogout(imUserId),
    ]);
    const compensated = results.every(
      (result) =>
        result.status === 'fulfilled' || this.isAlreadyAbsent(result.reason),
    );
    if (!compensated) {
      await this.prisma.tempChatGuest
        .update({
          where: { id: guestId },
          data: { provisioningFailedAt: new Date() },
        })
        .catch(() => undefined);
      this.logger.warn(
        `OpenIM guest compensation incomplete; retaining guest ${guestId} for teardown retry`,
      );
      return;
    }
    try {
      await this.prisma.tempChatGuest.delete({ where: { id: guestId } });
    } catch (cleanupError) {
      this.logger.warn(
        `Temp chat guest cleanup failed after OpenIM join failure: ${guestId}`,
        cleanupError instanceof Error ? cleanupError.stack : undefined,
      );
    }
  }

  private isAlreadyAbsent(error: unknown): boolean {
    const value = error instanceof Error ? error.message : String(error);
    return /RecordNotFoundError|not group member|already dismissed/i.test(
      value,
    );
  }
}
