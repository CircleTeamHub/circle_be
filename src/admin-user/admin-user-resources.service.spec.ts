import { NotFoundException } from '@nestjs/common';
import { AdminUserResourcesService } from './admin-user-resources.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { NoteService } from 'src/note/note.service';
import { AdminUserAuditService } from './admin-user-audit.service';
describe('user resource navigation and ownership', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    circleMember: { findMany: jest.fn(), count: jest.fn() },
    chatMember: { findMany: jest.fn(), count: jest.fn() },
    circle: { findMany: jest.fn() },
    circlePost: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
    note: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
  };
  const notes = { getNote: jest.fn() },
    audit = { recordInTransaction: jest.fn() };
  const service = new AdminUserResourcesService(
    prisma as unknown as PrismaService,
    notes as unknown as NoteService,
    audit as unknown as AdminUserAuditService,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.user.findUnique.mockResolvedValue({ id: 'user' });
    for (const model of [
      prisma.circleMember,
      prisma.chatMember,
      prisma.circlePost,
      prisma.note,
    ]) {
      model.findMany.mockResolvedValue([]);
      model.count.mockResolvedValue(0);
    }
    prisma.circle.findMany.mockResolvedValue([]);
    audit.recordInTransaction.mockResolvedValue({});
  });
  const page = { page: 2, limit: 20 };
  const actor = { userId: 'admin', accountId: 'local-admin' };
  it.each(['circles', 'groups', 'posts', 'noteList'] as const)(
    '%s rejects missing users',
    async (method) => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service[method]('missing', page)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.note.findMany).not.toHaveBeenCalled();
    },
  );
  it('paginates only active circle memberships, including the owner role', async () => {
    await service.circles('user', page);
    expect(prisma.circleMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userID: 'user', status: 'ACTIVE' },
        skip: 20,
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(
      prisma.circleMember.findMany.mock.calls[0][0].select,
    ).not.toHaveProperty('user');
  });
  it('uses actual active GROUP seats and canonical circle names, without per-user private preferences', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      {
        id: 'seat',
        joinedAt: new Date(),
        conversation: {
          id: 'conversation',
          name: 'stale',
          circleID: 'circle',
          _count: { members: 3 },
        },
      },
    ]);
    prisma.circle.findMany.mockResolvedValue([
      { id: 'circle', name: '真实圈名', deleted: false },
    ]);
    const result = await service.groups('user', page);
    expect(result.items[0].group).toMatchObject({
      id: 'conversation',
      name: '真实圈名',
      memberCount: 3,
    });
    const query = prisma.chatMember.findMany.mock.calls[0][0];
    expect(query.where).toEqual({
      userID: 'user',
      leftAt: null,
      conversation: { type: 'GROUP' },
    });
    expect(query.select).not.toHaveProperty('remark');
    expect(query.select).not.toHaveProperty('lastReadHeight');
  });
  it('paginates authored posts rather than posts from other circle members', async () => {
    await service.posts('user', page);
    expect(prisma.circlePost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { authorID: 'user' },
        skip: 20,
        take: 20,
      }),
    );
    expect(prisma.circlePost.count).toHaveBeenCalledWith({
      where: { authorID: 'user' },
    });
  });
  it('lists owned undeleted notes and labels collected copies without leaking source identifiers', async () => {
    prisma.note.findMany.mockResolvedValue([
      { id: 'note', title: '我的笔记', collectedFromNoteID: 'source' },
    ]);
    const result = await service.noteList('user', page);
    expect(result.items[0]).toEqual({
      id: 'note',
      title: '我的笔记',
      isCollected: true,
    });
    expect(prisma.note.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerID: 'user', status: { not: 'DELETED' } },
        skip: 20,
        take: 20,
      }),
    );
  });
  it('never reads or signs another user note through a mismatched URL', async () => {
    prisma.note.findFirst.mockResolvedValue(null);
    await expect(
      service.note('user', 'other-note', actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.note.findFirst).toHaveBeenCalledWith({
      where: { id: 'other-note', ownerID: 'user', status: { not: 'DELETED' } },
      select: { id: true },
    });
    expect(notes.getNote).not.toHaveBeenCalled();
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });
  it('reuses the existing owner note serializer/signing and writes a body-free read audit', async () => {
    prisma.note.findFirst.mockResolvedValue({ id: 'note' });
    notes.getNote.mockResolvedValue({
      title: 'private body',
      media: [{ url: 'signed-private-url' }],
    });
    await expect(service.note('user', 'note', actor)).resolves.toMatchObject({
      title: 'private body',
    });
    expect(notes.getNote).toHaveBeenCalledWith('user', 'note');
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        actorId: 'admin',
        targetId: 'user',
        action: 'ADMIN_USER_NOTE_VIEWED',
        metadata: { resourceId: 'note' },
      }),
    );
    expect(
      JSON.stringify(audit.recordInTransaction.mock.calls[0][1]),
    ).not.toMatch(/private body|signed-private-url/);
  });
  it('scopes post details to the author and fails closed if the audit cannot be saved', async () => {
    prisma.circlePost.findFirst.mockResolvedValue(null);
    await expect(service.post('user', 'post', actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.circlePost.findFirst.mock.calls[0][0].where).toEqual({
      id: 'post',
      authorID: 'user',
    });
    prisma.circlePost.findFirst.mockResolvedValue({
      id: 'post',
      content: 'body',
    });
    audit.recordInTransaction.mockRejectedValue(new Error('audit unavailable'));
    await expect(service.post('user', 'post', actor)).rejects.toThrow(
      'audit unavailable',
    );
  });
});
