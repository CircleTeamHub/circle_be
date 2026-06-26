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
      throw new GoneException('临时聊天已结束');
    }
    const memberCount = await this.prisma.tempChatGuest.count({
      where: { tempChatId: tcId },
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
      include: { _count: { select: { guests: true } } },
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
        const room = await tx.tempChat.findUnique({ where: { id: tcId } });
        if (
          !room ||
          room.status !== 'ACTIVE' ||
          room.expiresAt.getTime() <= Date.now()
        ) {
          throw new GoneException('临时聊天已结束');
        }
        const count = await tx.tempChatGuest.count({
          where: { tempChatId: tcId },
        });
        if (count >= room.maxMembers) {
          throw new ConflictException('人数已满');
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
      try {
        await this.prisma.tempChatGuest.delete({ where: { id: guest.id } });
      } catch (cleanupError) {
        this.logger.warn(
          `Temp chat guest cleanup failed after OpenIM join failure: ${guest.id}`,
          cleanupError instanceof Error ? cleanupError.stack : undefined,
        );
      }
      throw new ServiceUnavailableException('加入失败，请重试');
    }
  }

  async end(hostUserId: string, id: string): Promise<{ status: string }> {
    const room = await this.prisma.tempChat.findUniqueOrThrow({
      where: { id },
    });
    if (room.hostUserId !== hostUserId) {
      throw new ForbiddenException('只有创建者可以结束');
    }
    if (room.status !== 'ACTIVE') {
      return { status: room.status };
    }
    await this.teardown(room, TempChatStatus.ENDED);
    return { status: TempChatStatus.ENDED };
  }

  /** 解散群 + 强制访客下线 + 落库状态。幂等：仅对 ACTIVE 房调用。 */
  async teardown(
    room: { id: string; groupId: string },
    status: TempChatStatus,
  ): Promise<void> {
    await this.openim.dismissGroup(room.groupId).catch(() => undefined);
    const guests = await this.prisma.tempChatGuest.findMany({
      where: { tempChatId: room.id, cleanedUp: false },
      select: { imUserId: true },
    });
    for (const g of guests) {
      await this.openim.forceLogout(g.imUserId).catch(() => undefined);
    }
    await this.prisma.tempChatGuest.updateMany({
      where: { tempChatId: room.id },
      data: { cleanedUp: true },
    });
    await this.prisma.tempChat.update({
      where: { id: room.id },
      data: { status, endedAt: new Date() },
    });
  }
}
