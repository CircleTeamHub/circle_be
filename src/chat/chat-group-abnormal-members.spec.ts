import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ChatErrorCode } from 'src/common/app-error-codes';
import {
  classifyAbnormalMember,
  compareAbnormalMembers,
  inactiveCutoff,
  LOW_CREDIT_SCORE_THRESHOLD,
} from './chat-group-abnormal-members';
import { ChatGroupAdminService } from './chat-group-admin.service';
import { AbnormalMembersQueryDto } from './dto/group-admin.dto';

const NOW = new Date('2026-11-05T00:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const CUTOFF = inactiveCutoff(30, NOW);

const candidate = (overrides: Record<string, unknown> = {}) => ({
  userId: 'u-1',
  lastOnline: daysAgo(1),
  createdAt: daysAgo(400),
  creditScore: 100,
  shareOnlineStatus: true,
  ...overrides,
});

describe('classifyAbnormalMember', () => {
  it('ignores an active member with normal credit', () => {
    expect(classifyAbnormalMember(candidate(), CUTOFF)).toBeNull();
  });

  it('flags a long-inactive member with their last online time', () => {
    expect(
      classifyAbnormalMember(candidate({ lastOnline: daysAgo(45) }), CUTOFF),
    ).toEqual({
      userId: 'u-1',
      reasons: ['INACTIVE'],
      lastActiveAt: daysAgo(45).toISOString(),
      creditScore: null,
    });
  });

  it('falls back to the sign-up time when no online time was ever recorded', () => {
    expect(
      classifyAbnormalMember(candidate({ lastOnline: null }), CUTOFF),
    ).toMatchObject({ reasons: ['INACTIVE'], lastActiveAt: null });
    expect(
      classifyAbnormalMember(
        candidate({ lastOnline: null, createdAt: daysAgo(3) }),
        CUTOFF,
      ),
    ).toBeNull();
  });

  it('does not judge inactivity for members who hide their online status', () => {
    expect(
      classifyAbnormalMember(
        candidate({ lastOnline: daysAgo(200), shareOnlineStatus: false }),
        CUTOFF,
      ),
    ).toBeNull();
    // 信誉值照常判,也不顺带透出在线时间。
    expect(
      classifyAbnormalMember(
        candidate({
          lastOnline: daysAgo(200),
          shareOnlineStatus: false,
          creditScore: 20,
        }),
        CUTOFF,
      ),
    ).toEqual({
      userId: 'u-1',
      reasons: ['LOW_CREDIT'],
      lastActiveAt: null,
      creditScore: 20,
    });
  });

  it('flags credit below the low tier only, and reveals the score only then', () => {
    expect(
      classifyAbnormalMember(
        candidate({ creditScore: LOW_CREDIT_SCORE_THRESHOLD }),
        CUTOFF,
      ),
    ).toBeNull();
    expect(
      classifyAbnormalMember(
        candidate({ creditScore: LOW_CREDIT_SCORE_THRESHOLD - 1 }),
        CUTOFF,
      ),
    ).toMatchObject({ reasons: ['LOW_CREDIT'], creditScore: 59 });
  });
});

describe('compareAbnormalMembers', () => {
  it('puts double hits first, then the longest inactive, then the lowest credit', () => {
    const both = classifyAbnormalMember(
      candidate({ userId: 'both', lastOnline: daysAgo(40), creditScore: 50 }),
      CUTOFF,
    )!;
    const older = classifyAbnormalMember(
      candidate({ userId: 'older', lastOnline: daysAgo(90) }),
      CUTOFF,
    )!;
    const never = classifyAbnormalMember(
      candidate({ userId: 'never', lastOnline: null }),
      CUTOFF,
    )!;
    const recent = classifyAbnormalMember(
      candidate({ userId: 'recent', lastOnline: daysAgo(31) }),
      CUTOFF,
    )!;
    const low = classifyAbnormalMember(
      candidate({ userId: 'low', creditScore: 10 }),
      CUTOFF,
    )!;
    const lower = classifyAbnormalMember(
      candidate({ userId: 'lower', creditScore: 5 }),
      CUTOFF,
    )!;
    expect(
      [low, recent, lower, both, older, never]
        .sort(compareAbnormalMembers)
        .map((member) => member.userId),
    ).toEqual(['both', 'never', 'older', 'recent', 'lower', 'low']);
  });
});

describe('AbnormalMembersQueryDto', () => {
  const errors = (query: Record<string, unknown>) =>
    validateSync(plainToInstance(AbnormalMembersQueryDto, query));

  it('accepts the published day options from the query string', () => {
    expect(errors({})).toHaveLength(0);
    expect(errors({ inactiveDays: '7' })).toHaveLength(0);
    expect(errors({ inactiveDays: '90' })).toHaveLength(0);
  });

  it('rejects arbitrary day counts', () => {
    expect(errors({ inactiveDays: '1' })).not.toHaveLength(0);
    expect(errors({ inactiveDays: 'abc' })).not.toHaveLength(0);
  });
});

describe('ChatGroupAdminService.listAbnormalMembers', () => {
  const prisma = {
    chatMember: { findUnique: jest.fn(), findMany: jest.fn() },
    circleMember: { findUnique: jest.fn(), findMany: jest.fn() },
    user: { findMany: jest.fn() },
  };
  const service = new ChatGroupAdminService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const seat = (userID: string, role = 'MEMBER') => ({
    userID,
    role,
    leftAt: null,
  });
  const arrangeActor = (
    actor: ReturnType<typeof seat>,
    conversation: Record<string, unknown> = {},
  ) => {
    prisma.chatMember.findUnique.mockResolvedValue({
      ...actor,
      conversation: {
        id: 'conv-1',
        type: 'GROUP',
        circleID: null,
        ownerID: 'owner-1',
        ...conversation,
      },
    });
  };
  const user = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    lastOnline: new Date(Date.now() - 60 * 86_400_000),
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    creditScore: 100,
    privacySetting: null,
    ...overrides,
  });

  beforeEach(() => jest.clearAllMocks());

  it('rejects plain members without reading the roster', async () => {
    arrangeActor(seat('u-2'));
    await expect(
      service.listAbnormalMembers('u-2', 'conv-1', 30),
    ).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: { errorCode: ChatErrorCode.GroupManagerOnly },
    });
    expect(prisma.chatMember.findMany).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('lets a standalone admin see plain members only', async () => {
    arrangeActor(seat('admin-1', 'ADMIN'));
    prisma.chatMember.findMany.mockResolvedValue([
      seat('owner-1'),
      seat('admin-2', 'ADMIN'),
      seat('u-3'),
    ]);
    prisma.user.findMany.mockResolvedValue([user('u-3')]);

    const result = await service.listAbnormalMembers('admin-1', 'conv-1', 30);

    expect(prisma.chatMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationID: 'conv-1',
          leftAt: null,
          userID: { not: 'admin-1' },
        },
      }),
    );
    expect(prisma.user.findMany.mock.calls[0][0].where.id).toEqual({
      in: ['u-3'],
    });
    expect(result).toMatchObject({
      inactiveDays: 30,
      creditThreshold: LOW_CREDIT_SCORE_THRESHOLD,
      members: [{ userId: 'u-3', reasons: ['INACTIVE'] }],
    });
  });

  it('uses circle roles for circle groups and lets the owner see admins', async () => {
    arrangeActor(seat('owner-1'), { circleID: 'circle-1', ownerID: null });
    prisma.circleMember.findUnique.mockResolvedValue({
      role: 'OWNER',
      status: 'ACTIVE',
    });
    prisma.chatMember.findMany.mockResolvedValue([
      seat('admin-2'),
      seat('left-circle'),
      seat('u-3'),
    ]);
    prisma.circleMember.findMany.mockResolvedValue([
      { userID: 'admin-2', role: 'ADMIN', status: 'ACTIVE' },
      { userID: 'left-circle', role: 'MEMBER', status: 'LEFT' },
      { userID: 'u-3', role: 'MEMBER', status: 'ACTIVE' },
    ]);
    prisma.user.findMany.mockResolvedValue([
      user('admin-2', { lastOnline: new Date(), creditScore: 30 }),
      user('u-3', { privacySetting: { shareOnlineStatus: false } }),
    ]);

    const result = await service.listAbnormalMembers('owner-1', 'conv-1', 30);

    expect(prisma.user.findMany.mock.calls[0][0].where.id).toEqual({
      in: ['admin-2', 'u-3'],
    });
    // u-3 关掉了在线状态,不按未登录判;admin-2 信誉值低。
    expect(result.members).toEqual([
      {
        userId: 'admin-2',
        reasons: ['LOW_CREDIT'],
        lastActiveAt: null,
        creditScore: 30,
      },
    ]);
  });

  it('skips the user query when nobody is manageable', async () => {
    arrangeActor(seat('admin-1', 'ADMIN'));
    prisma.chatMember.findMany.mockResolvedValue([seat('admin-2', 'ADMIN')]);

    const result = await service.listAbnormalMembers('admin-1', 'conv-1', 7);

    expect(result).toEqual({
      inactiveDays: 7,
      creditThreshold: LOW_CREDIT_SCORE_THRESHOLD,
      members: [],
    });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
