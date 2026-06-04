import { GoneException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { OpenimService } from 'src/openim/openim.service';
import { LinkTokenService } from './link-token.service';
import { CreateTempChatDto } from './dto/create-temp-chat.dto';
import { newGroupId } from './temp-chat.ids';

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

@Injectable()
export class TempChatService {
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
}
