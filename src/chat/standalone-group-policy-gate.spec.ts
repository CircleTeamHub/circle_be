import { isBlockedByStandaloneGroupPolicy } from './standalone-group-policy-gate';

/**
 * 「成员可查看他人资料 / 成员可添加好友」的服务端推导:只通过关着开关的独立群
 * 认识的两个人才被挡;好友、对方先发的申请、同圈子、任一共同群开着开关、
 * actor 是某个共同群的群主/管理员、根本没有共同群 —— 都放行。
 */
describe('isBlockedByStandaloneGroupPolicy', () => {
  const prisma = {
    chatMember: { findMany: jest.fn() },
    friend: { findFirst: jest.fn() },
    circleMember: { findFirst: jest.fn() },
  };
  const gate = (policy: 'membersCanViewProfiles' | 'membersCanAddFriends') =>
    isBlockedByStandaloneGroupPolicy(prisma as never, 'me', 'other', policy);
  const seat = (
    conversation: Partial<{
      ownerID: string | null;
      membersCanViewProfiles: boolean;
      membersCanAddFriends: boolean;
    }> = {},
    role: 'MEMBER' | 'ADMIN' = 'MEMBER',
  ) => ({
    role,
    conversation: {
      ownerID: 'owner-9',
      membersCanViewProfiles: false,
      membersCanAddFriends: false,
      ...conversation,
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.chatMember.findMany.mockResolvedValue([]);
    prisma.friend.findFirst.mockResolvedValue(null);
    prisma.circleMember.findFirst.mockResolvedValue(null);
  });

  it('never blocks self and does not query', async () => {
    await expect(
      isBlockedByStandaloneGroupPolicy(
        prisma as never,
        'me',
        'me',
        'membersCanViewProfiles',
      ),
    ).resolves.toBe(false);
    expect(prisma.chatMember.findMany).not.toHaveBeenCalled();
  });

  it('is not a group matter when the two share no standalone group', async () => {
    await expect(gate('membersCanAddFriends')).resolves.toBe(false);
    // 只查共同独立群(且只看在座的、对方也在座的、circleID 为空的 GROUP)。
    expect(prisma.chatMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userID: 'me',
          leftAt: null,
          conversation: {
            type: 'GROUP',
            circleID: null,
            members: { some: { userID: 'other', leftAt: null } },
          },
        },
      }),
    );
    expect(prisma.friend.findFirst).not.toHaveBeenCalled();
    expect(prisma.circleMember.findFirst).not.toHaveBeenCalled();
  });

  it('blocks when every shared standalone group has the policy off and the actor is a plain member', async () => {
    prisma.chatMember.findMany.mockResolvedValue([seat(), seat()]);
    await expect(gate('membersCanViewProfiles')).resolves.toBe(true);
    await expect(gate('membersCanAddFriends')).resolves.toBe(true);
  });

  it('keys on the requested policy only', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      seat({ membersCanViewProfiles: true, membersCanAddFriends: false }),
    ]);
    await expect(gate('membersCanViewProfiles')).resolves.toBe(false);
    await expect(gate('membersCanAddFriends')).resolves.toBe(true);
  });

  it('lets one permitting group override the closed ones', async () => {
    prisma.chatMember.findMany.mockResolvedValue([
      seat(),
      seat({ membersCanAddFriends: true }),
    ]);
    await expect(gate('membersCanAddFriends')).resolves.toBe(false);
    expect(prisma.friend.findFirst).not.toHaveBeenCalled();
  });

  it('exempts the owner and seated admins of a shared group', async () => {
    prisma.chatMember.findMany.mockResolvedValue([seat({ ownerID: 'me' })]);
    await expect(gate('membersCanViewProfiles')).resolves.toBe(false);
    prisma.chatMember.findMany.mockResolvedValue([seat({}, 'ADMIN')]);
    await expect(gate('membersCanViewProfiles')).resolves.toBe(false);
  });

  it('lets friends and pending requests from the target through', async () => {
    prisma.chatMember.findMany.mockResolvedValue([seat()]);
    prisma.friend.findFirst.mockResolvedValue({ id: 'friend-1' });
    await expect(gate('membersCanViewProfiles')).resolves.toBe(false);
    expect(prisma.friend.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { userID: 'me', friendID: 'other', state: 'ACCEPTED' },
            {
              userID: 'other',
              friendID: 'me',
              state: { in: ['ACCEPTED', 'PENDING'] },
            },
          ],
        },
      }),
    );
    expect(prisma.circleMember.findFirst).not.toHaveBeenCalled();
  });

  it('lets active co-members of an undeleted circle through', async () => {
    prisma.chatMember.findMany.mockResolvedValue([seat()]);
    prisma.circleMember.findFirst.mockResolvedValue({ id: 'cm-1' });
    await expect(gate('membersCanAddFriends')).resolves.toBe(false);
    expect(prisma.circleMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userID: 'me',
          status: 'ACTIVE',
          circle: {
            deleted: false,
            members: { some: { userID: 'other', status: 'ACTIVE' } },
          },
        },
      }),
    );
  });
});
