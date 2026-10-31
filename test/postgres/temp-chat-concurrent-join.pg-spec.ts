import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { TempChatErrorCode } from 'src/common/app-error-codes';
import { TempChatService } from 'src/temp-chat/temp-chat.service';
import { describePostgres } from './pg-test-db';
import { openPrismaSchema, type PrismaSchemaDb } from './prisma-schema-db';

/**
 * 同一个临时聊天链接被几个人几乎同时点开(真库、真 TempChatService.join)。
 *
 * join 在房间级 advisory 锁里复查状态与人数再占座。它曾经同时开着 Serializable:
 * 快照在第一条语句(就是取锁那条)开始时就固定了,排队拿到锁的事务读到的仍是
 * 前一个提交之前的人数,写入时被 SSI 判成 40001 —— 没有重试,访客直接拿到 500。
 * 锁本身已经把占座串行化,READ COMMITTED 下每条语句都在拿到锁之后取快照。
 */
describePostgres('TempChatService.join under concurrent guests', () => {
  let schemaDb: PrismaSchemaDb;

  beforeAll(async () => {
    schemaDb = await openPrismaSchema('temp_chat_join');
  });

  afterAll(async () => {
    await schemaDb?.close();
  });

  async function joinConcurrently(maxMembers: number, guests: number) {
    const { prisma } = schemaDb.client(guests + 2);
    const room = await prisma.tempChat.create({
      data: {
        groupId: randomUUID(),
        hostUserId: randomUUID(),
        maxMembers,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await prisma.chatConversation.create({
      data: { type: 'TEMP', tempChatID: room.id },
    });

    const service = new TempChatService(
      prisma as never,
      {
        verify: () => ({ tcId: room.id }),
        signGuest: () => 'guest-token',
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { check: () => ({ blocked: false }) } as never,
    );

    const results = await Promise.allSettled(
      Array.from({ length: guests }, (_, index) =>
        service.join('link-token', { displayName: `guest-${index}` }),
      ),
    );
    const seated = await prisma.tempChatGuest.count({
      where: { tempChatId: room.id },
    });
    return { results, seated };
  }

  it('seats every guest who joins at the same moment', async () => {
    const { results, seated } = await joinConcurrently(50, 6);

    expect(results.filter((result) => result.status === 'rejected')).toEqual(
      [],
    );
    expect(seated).toBe(6);
  });

  it('never seats more guests than the room allows, even all at once', async () => {
    const { results, seated } = await joinConcurrently(3, 6);

    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(3);
    for (const { reason } of rejected) {
      expect(reason).toBeInstanceOf(ConflictException);
      expect((reason as ConflictException).getResponse()).toMatchObject({
        errorCode: TempChatErrorCode.Full,
      });
    }
    expect(seated).toBe(3);
  });
});
