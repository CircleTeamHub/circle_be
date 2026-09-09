import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { ChatGroupEventService } from './chat-group-event.service';

/**
 * 群日志的读侧闸门与分页契约:圈子群同成员目录(圈主/管理员),独立群聊全员;
 * (createdAt, id) 复合游标,坏游标 400 而不是静默从头翻;尽力而为的 record()
 * 吞错,事务内的 recordInTx 抛错。
 */
describe('ChatGroupEventService', () => {
  const prisma = {
    chatMember: { findUnique: jest.fn() },
    circleMember: { findUnique: jest.fn() },
    chatGroupEvent: { findMany: jest.fn(), create: jest.fn() },
    user: { findMany: jest.fn() },
  };
  const service = new ChatGroupEventService(prisma as never);

  const seat = (overrides: Record<string, unknown> = {}) => ({
    leftAt: null,
    conversation: { type: 'GROUP', circleID: null },
    ...overrides,
  });
  const row = (n: number, overrides: Record<string, unknown> = {}) => ({
    id: `event-${n}`,
    conversationID: 'conv-1',
    kind: 'member-joined',
    actorID: 'owner-1',
    targetIDs: ['u-2'],
    payload: null,
    createdAt: new Date(Date.UTC(2026, 8, 8, 0, 0, n)),
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.chatMember.findUnique.mockResolvedValue(seat());
    prisma.chatGroupEvent.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
  });

  it('rejects callers without an active seat', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(null);
    await expect(service.listEvents('u-1', 'conv-1', {})).rejects.toMatchObject(
      {
        constructor: ForbiddenException,
        response: { errorCode: ChatErrorCode.NotMember },
      },
    );
    expect(prisma.chatGroupEvent.findMany).not.toHaveBeenCalled();
  });

  it('gates circle groups like the member directory (owner/admin only)', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(
      seat({ conversation: { type: 'GROUP', circleID: 'circle-1' } }),
    );
    prisma.circleMember.findUnique.mockResolvedValue({
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    await expect(service.listEvents('u-1', 'conv-1', {})).rejects.toMatchObject(
      {
        constructor: ForbiddenException,
        response: { errorCode: ChatErrorCode.MemberDirectoryForbidden },
      },
    );

    prisma.circleMember.findUnique.mockResolvedValue({
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    await expect(service.listEvents('u-1', 'conv-1', {})).resolves.toEqual({
      events: [],
      nextCursor: null,
    });
  });

  it('lets every seated member of a standalone group read the log', async () => {
    prisma.chatGroupEvent.findMany.mockResolvedValue([row(1)]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'owner-1', nickname: 'Owner', avatarUrl: null },
    ]);
    const page = await service.listEvents('u-2', 'conv-1', {});
    expect(prisma.circleMember.findUnique).not.toHaveBeenCalled();
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      id: 'event-1',
      kind: 'member-joined',
      actor: { id: 'owner-1', nickname: 'Owner' },
      // 查不到的账号保留 id、昵称空串,由客户端兜底文案。
      targets: [{ id: 'u-2', nickname: '', avatarUrl: null }],
      payload: null,
    });
    expect(page.nextCursor).toBeNull();
  });

  it('paginates with a (createdAt, id) keyset cursor', async () => {
    prisma.chatGroupEvent.findMany.mockResolvedValue([row(3), row(2), row(1)]);
    const first = await service.listEvents('u-2', 'conv-1', { limit: 2 });
    expect(prisma.chatGroupEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
      }),
    );
    expect(first.events.map((e) => e.id)).toEqual(['event-3', 'event-2']);
    expect(first.nextCursor).toEqual(expect.any(String));

    prisma.chatGroupEvent.findMany.mockResolvedValue([row(1)]);
    const second = await service.listEvents('u-2', 'conv-1', {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    const where = prisma.chatGroupEvent.findMany.mock.calls[1][0].where;
    expect(where.OR).toEqual([
      { createdAt: { lt: row(2).createdAt } },
      { createdAt: row(2).createdAt, id: { lt: 'event-2' } },
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects a cursor it cannot decode instead of restarting from the top', async () => {
    await expect(
      service.listEvents('u-2', 'conv-1', { cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      response: { errorCode: ChatErrorCode.InvalidPayload },
    });
    expect(prisma.chatGroupEvent.findMany).not.toHaveBeenCalled();
  });

  it('dedupes targets and stores the payload on recordInTx', async () => {
    await service.recordInTx(prisma as never, 'conv-1', {
      kind: 'member-joined',
      actorId: 'owner-1',
      targetIds: ['u-2', 'u-2', 'u-3'],
      payload: { via: 'qr' },
    });
    expect(prisma.chatGroupEvent.create).toHaveBeenCalledWith({
      data: {
        conversationID: 'conv-1',
        kind: 'member-joined',
        actorID: 'owner-1',
        targetIDs: ['u-2', 'u-3'],
        payload: { via: 'qr' },
      },
    });
  });

  it('record() is best-effort while recordInTx propagates failures', async () => {
    prisma.chatGroupEvent.create.mockRejectedValue(new Error('db down'));
    await expect(
      service.record('conv-1', { kind: 'member-left', actorId: 'u-2' }),
    ).resolves.toBeUndefined();
    await expect(
      service.recordInTx(prisma as never, 'conv-1', {
        kind: 'member-left',
        actorId: 'u-2',
      }),
    ).rejects.toThrow('db down');
  });
});
