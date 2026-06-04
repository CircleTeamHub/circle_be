import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TempChatStatus } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { TempChatService } from './temp-chat.service';

@Injectable()
export class TempChatCleanup {
  private readonly logger = new Logger(TempChatCleanup.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly service: TempChatService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    const due = await this.prisma.tempChat.findMany({
      where: { status: TempChatStatus.ACTIVE, expiresAt: { lte: new Date() } },
      select: { id: true, groupId: true },
    });
    for (const room of due) {
      try {
        await this.service.teardown(room, TempChatStatus.EXPIRED);
      } catch (err) {
        this.logger.error(`teardown failed for ${room.id}: ${String(err)}`);
      }
    }
  }
}
