import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { NoteRatingAdminService } from './note-rating-admin.service';

const ADMIN = 'admin-1';
const OWNER = 'owner-1';
const DAY = new Date('2026-11-11T00:00:00.000Z');

const user = (id: string) => ({
  id,
  accountId: `acc-${id}`,
  nickname: id,
  avatarUrl: null,
});

function setup(
  kind: 'BURST' | 'APPEAL',
  ratings: Array<Record<string, unknown>>,
  over: { claimed?: number; found?: boolean } = {},
) {
  const caseRow = {
    id: 'case-1',
    kind,
    status: 'RESOLVED',
    ownerID: OWNER,
    ownerReason: kind === 'APPEAL' ? 'It is accurate' : null,
    resolution: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: DAY,
    owner: user(OWNER),
    resolvedBy: user(ADMIN),
    items: ratings.map((rating) => ({
      rating: {
        reason: null,
        comment: null,
        createdAt: DAY,
        rater: {
          ...user(rating.raterID as string),
          creditScore: 100,
          createdAt: DAY,
        },
        ...rating,
      },
    })),
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    $executeRaw: jest.fn(async () => 1),
    noteRatingCase: {
      findUnique: jest.fn(async () =>
        over.found === false ? null : { kind, ownerID: OWNER },
      ),
      updateMany: jest.fn(async () => ({ count: over.claimed ?? 1 })),
      findUniqueOrThrow: jest.fn(async () => caseRow),
      findMany: jest.fn(async () => [caseRow]),
      count: jest.fn(async () => 1),
    },
    noteRating: {
      findMany: jest.fn(async () => ratings),
      updateMany: jest.fn(async () => ({ count: ratings.length })),
    },
    note: {
      findUnique: jest.fn(async () => ({
        title: 'Dumpling shop on 5th street',
      })),
      findMany: jest.fn(async () => [
        {
          id: 'note-1',
          title: 'Dumpling shop on 5th street',
          status: 'ACTIVE',
        },
      ]),
    },
  };
  const credit = {
    applyDeltaInTransaction: jest.fn(async () => ({
      eventId: 'e',
      scoreBefore: 100,
      scoreAfter: 85,
    })),
    broadcastCreditProfileChanged: jest.fn(async () => undefined),
  };
  const notifications = {
    createSystemNotification: jest.fn(async () => ({ id: 'n' })),
  };
  const realtime = {
    safeBroadcastAll: jest.fn(async () => undefined),
    broadcastSystemNotificationCreated: jest.fn(),
    broadcastNotificationCreated: jest.fn(),
    broadcastSystemNotificationUnread: jest.fn(),
  };
  const service = new NoteRatingAdminService(
    prisma as never,
    credit as never,
    notifications as never,
    realtime as never,
  );
  return { service, prisma, credit, notifications };
}

const held = (id: string, raterID: string) => ({
  id,
  noteID: 'note-1',
  value: 'GOOD',
  status: 'HELD',
  ratedDay: DAY,
  raterID,
});

describe('NoteRatingAdminService.resolveCase', () => {
  it('releases a burst: held ratings count again, nobody is penalised', async () => {
    const { service, prisma, credit, notifications } = setup('BURST', [
      held('r1', 'u1'),
      held('r2', 'u2'),
      { ...held('r3', 'u3'), status: 'VOID' },
    ]);

    await service.resolveCase(ADMIN, 'case-1', { action: 'RELEASE' });

    expect(prisma.$executeRaw.mock.calls[0].slice(1)).toEqual([
      `note_rating:owner:${OWNER}`,
    ]);
    expect(prisma.noteRatingCase.updateMany).toHaveBeenCalledWith({
      where: { id: 'case-1', status: 'PENDING' },
      data: expect.objectContaining({
        status: 'RESOLVED',
        resolution: 'RELEASE',
        resolvedByID: ADMIN,
      }),
    });
    expect(prisma.noteRating.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1', 'r2'] } },
      data: { status: 'COUNTED' },
    });
    // Two day rows + two month rows go back up.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1 + 4);
    expect(credit.applyDeltaInTransaction).not.toHaveBeenCalled();
    expect(notifications.createSystemNotification).not.toHaveBeenCalled();
  });

  it('voids a burst and deducts 15 credit per voided rating, once each', async () => {
    const { service, prisma, credit, notifications } = setup('BURST', [
      held('r1', 'u1'),
      held('r2', 'u2'),
    ]);

    await service.resolveCase(ADMIN, 'case-1', {
      action: 'VOID',
      note: 'ring',
    });

    expect(prisma.noteRating.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1', 'r2'] } },
      data: { status: 'VOID' },
    });
    expect(credit.applyDeltaInTransaction).toHaveBeenCalledTimes(2);
    expect(credit.applyDeltaInTransaction).toHaveBeenCalledWith(prisma, {
      userId: 'u1',
      delta: -15,
      reason: 'NOTE_RATING_ABUSE',
      sourceType: 'NOTE_RATING',
      sourceId: 'r1',
      actorId: ADMIN,
      idempotencyKey: 'note-rating-void:r1',
      metadata: { caseId: 'case-1', kind: 'BURST' },
    });
    expect(credit.broadcastCreditProfileChanged).toHaveBeenCalledWith('u1');
    expect(notifications.createSystemNotification).toHaveBeenCalledWith(
      'u2',
      'u2',
      expect.stringContaining('15'),
    );
  });

  it('revokes an appealed bad rating: VOID, counters down, rater penalised, owner told', async () => {
    const counted = {
      id: 'r9',
      noteID: 'note-1',
      value: 'BAD',
      status: 'COUNTED',
      ratedDay: DAY,
      raterID: 'u9',
    };
    const { service, prisma, credit, notifications } = setup('APPEAL', [
      counted,
    ]);

    await service.resolveCase(ADMIN, 'case-1', { action: 'REVOKE' });

    expect(prisma.noteRating.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['r9'] } },
      data: { status: 'VOID' },
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1 + 2);
    expect(credit.applyDeltaInTransaction).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ userId: 'u9', delta: -15 }),
    );
    expect(notifications.createSystemNotification).toHaveBeenCalledWith(
      OWNER,
      OWNER,
      '你对笔记「Dumpling shop on 5th street」一条差评的申诉已通过，该差评已撤销。',
    );
  });

  it('upholds an appeal: nothing changes except the owner hearing the result', async () => {
    const { service, prisma, credit, notifications } = setup('APPEAL', [
      { ...held('r9', 'u9'), value: 'BAD', status: 'COUNTED' },
    ]);

    await service.resolveCase(ADMIN, 'case-1', { action: 'UPHOLD' });

    expect(prisma.noteRating.updateMany).not.toHaveBeenCalled();
    expect(credit.applyDeltaInTransaction).not.toHaveBeenCalled();
    expect(notifications.createSystemNotification).toHaveBeenCalledWith(
      OWNER,
      OWNER,
      expect.stringContaining('未通过'),
    );
  });

  it.each([
    ['BURST', 'UPHOLD'],
    ['BURST', 'REVOKE'],
    ['APPEAL', 'RELEASE'],
    ['APPEAL', 'VOID'],
  ] as const)('rejects %s + %s', async (kind, action) => {
    const { service, prisma } = setup(kind, []);

    const error = await service
      .resolveCase(ADMIN, 'case-1', { action })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      errorCode: 'NOTE_RATING_CASE_ACTION_INVALID',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('lets only the first admin resolve a case', async () => {
    const { service, prisma, credit } = setup('BURST', [held('r1', 'u1')], {
      claimed: 0,
    });

    const error = await service
      .resolveCase(ADMIN, 'case-1', { action: 'VOID' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      errorCode: 'NOTE_RATING_CASE_RESOLVED',
    });
    expect(prisma.noteRating.findMany).not.toHaveBeenCalled();
    expect(credit.applyDeltaInTransaction).not.toHaveBeenCalled();
  });

  it('404s an unknown case', async () => {
    const { service } = setup('BURST', [], { found: false });

    await expect(
      service.resolveCase(ADMIN, 'nope', { action: 'VOID' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps a committed decision when a notification fails', async () => {
    const { service, notifications } = setup('BURST', [held('r1', 'u1')]);
    notifications.createSystemNotification.mockRejectedValueOnce(
      new Error('push down'),
    );

    await expect(
      service.resolveCase(ADMIN, 'case-1', { action: 'VOID' }),
    ).resolves.toMatchObject({ id: 'case-1' });
  });
});

describe('NoteRatingAdminService.listCases', () => {
  it('lists the pending queue oldest first with rater evidence', async () => {
    const { service, prisma } = setup('BURST', [held('r1', 'u1')]);
    prisma.note.findMany.mockResolvedValueOnce([]);

    const page = await service.listCases({});

    expect(prisma.noteRatingCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        skip: 0,
        take: 20,
      }),
    );
    expect(page).toMatchObject({
      total: 1,
      page: 1,
      limit: 20,
      hasMore: false,
    });
    expect(page.items[0].ratings[0]).toMatchObject({
      id: 'r1',
      // The note was purged: the rating still shows, without a title.
      note: { id: 'note-1', title: null, status: null },
      rater: { id: 'u1', accountId: 'acc-u1', creditScore: 100 },
    });
  });
});
