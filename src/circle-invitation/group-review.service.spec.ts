import { ForbiddenException } from '@nestjs/common';
import { GroupReviewService } from './group-review.service';

function harness(circle = false) {
  const prisma: any = {
    circle: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ name: 'Circle', deleted: false }),
    },
    chatConversation: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'group',
        type: 'GROUP',
        circleID: circle ? 'circle' : null,
        ownerID: 'owner',
        name: 'Group',
        circle: circle ? { name: 'Circle', deleted: false } : null,
      }),
    },
    chatMember: {
      findUnique: jest.fn().mockResolvedValue({ role: 'ADMIN', leftAt: null }),
    },
    circleMember: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ role: 'ADMIN', status: 'ACTIVE' }),
    },
    groupAdmission: {
      findMany: jest.fn().mockResolvedValue([{ id: 'good' }, { id: 'bad' }]),
      findFirst: jest.fn(),
    },
    circleInvitation: {
      findMany: jest.fn().mockResolvedValue([{ id: 'good' }]),
      findFirst: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const admissions = { act: jest.fn().mockResolvedValue({ status: 'JOINED' }) };
  const invitations = {
    adminApprove: jest.fn().mockResolvedValue(undefined),
    adminReject: jest.fn().mockResolvedValue(undefined),
  };
  return {
    prisma,
    admissions,
    invitations,
    service: new GroupReviewService(
      prisma,
      admissions as never,
      invitations as never,
    ),
  };
}

describe('group application management', () => {
  it('does not expose applicant identities to a normal group member', async () => {
    const h = harness();
    h.prisma.chatMember.findUnique.mockResolvedValue({
      role: 'MEMBER',
      leftAt: null,
    });
    await expect(h.service.list('member', 'group', {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('searches before pagination and binds nickname/account input as SQL values', async () => {
    const h = harness();
    await h.service.list('owner', 'group', {
      keyword: "a' OR true--",
      limit: 20,
    });
    const sql = h.prisma.$queryRaw.mock.calls[0][0];
    expect(sql.values).toContain("%a' OR true--%");
    expect(sql.values).toContain('group');
    expect(sql.values).toContain(21);
    expect(sql.strings.join('')).not.toContain("a' OR true--");
  });

  it('preserves per-item failure and refuses request IDs from another group', async () => {
    const h = harness();
    h.admissions.act.mockImplementation((_user, id) =>
      id === 'bad'
        ? Promise.reject(
            new ForbiddenException({ errorCode: 'CHAT_GROUP_FULL' }),
          )
        : Promise.resolve({ status: 'JOINED' }),
    );
    const result = await h.service.act(
      'owner',
      'group',
      ['good', 'bad', 'foreign'],
      'approve',
    );
    expect(result.results).toEqual([
      { id: 'good', ok: true },
      { id: 'bad', ok: false, errorCode: 'CHAT_GROUP_FULL' },
      { id: 'foreign', ok: false, errorCode: 'CHAT_GROUP_REQUEST_UNAVAILABLE' },
    ]);
    expect(h.admissions.act).toHaveBeenCalledTimes(2);
  });

  it('uses circle decisions and the transactional reject-and-ban path for circle groups', async () => {
    const h = harness(true);
    await h.service.act('owner', 'group', ['good'], 'blacklist');
    expect(h.invitations.adminReject).toHaveBeenCalledWith(
      'owner',
      'good',
      true,
    );
    expect(h.admissions.act).not.toHaveBeenCalled();
  });

  it('does not report a stale rejection as successful after another manager approved', async () => {
    const h = harness();
    h.admissions.act.mockResolvedValue({ status: 'JOINED' });
    expect(await h.service.act('owner', 'group', ['good'], 'reject')).toEqual({
      results: [
        {
          id: 'good',
          ok: false,
          errorCode: 'CHAT_GROUP_REQUEST_ALREADY_DECIDED',
        },
      ],
    });
  });
});
