import { ChatErrorCode } from 'src/common/app-error-codes';
import { UserService } from './user.service';

/**
 * 「成员可查看他人资料」的服务端门:GET /user/:id 是资料页唯一的数据源,
 * 关掉开关之后前端隐藏入口只是装饰 —— 真正的拒绝必须发生在这里。
 *
 * 判定本身在 standalone-group-policy-gate 有自己的单测;这里钉的是「findOne
 * 真的把它接上了、拒绝时不去读用户行、放行时照常返回」。
 */
describe('UserService.findOne profile visibility', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    chatMember: { findMany: jest.fn() },
    friend: { findFirst: jest.fn() },
    circleMember: { findFirst: jest.fn() },
    userLike: { findUnique: jest.fn() },
  };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const iconService = { getDisplayIconsForUser: jest.fn() };
  const avatarFrames = { resolvePublicAppearances: jest.fn() };
  const privacySettings = { canViewProfileField: jest.fn() };

  const service = new UserService(
    prisma as never,
    config as never,
    {} as never,
    iconService as never,
    {} as never,
    privacySettings as never,
    avatarFrames as never,
  );

  /** 只通过一个关着开关的独立群认识:群主是别人,本人是普通成员。 */
  const closedSharedGroup = [
    {
      role: 'MEMBER',
      conversation: {
        ownerID: 'owner-9',
        membersCanViewProfiles: false,
        membersCanAddFriends: false,
      },
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.chatMember.findMany.mockResolvedValue([]);
    prisma.friend.findFirst.mockResolvedValue(null);
    prisma.circleMember.findFirst.mockResolvedValue(null);
    prisma.userLike.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({
      id: 'target',
      nickname: '目标',
      avatarUrl: null,
      phoneNumber: '13800000000',
      email: null,
      wechat: null,
      qq: null,
      whatsup: null,
      receivedLikeCount: 3,
    });
    iconService.getDisplayIconsForUser.mockResolvedValue([]);
    avatarFrames.resolvePublicAppearances.mockResolvedValue(new Map());
    privacySettings.canViewProfileField.mockResolvedValue(false);
  });

  it('refuses the read when the only shared context is a group with profiles turned off', async () => {
    prisma.chatMember.findMany.mockResolvedValue(closedSharedGroup);

    await expect(service.findOne('target', 'viewer')).rejects.toMatchObject({
      response: { errorCode: ChatErrorCode.MemberProfileForbidden },
    });
    // 拒绝要在读到资料之前发生,否则 403 只是把已经查出来的资料丢掉。
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('lets friends, shared-circle members and permitting groups through', async () => {
    prisma.chatMember.findMany.mockResolvedValue(closedSharedGroup);
    prisma.friend.findFirst.mockResolvedValue({ id: 'friend-1' });
    await expect(service.findOne('target', 'viewer')).resolves.toMatchObject({
      id: 'target',
    });

    prisma.friend.findFirst.mockResolvedValue(null);
    prisma.circleMember.findFirst.mockResolvedValue({ id: 'cm-1' });
    await expect(service.findOne('target', 'viewer')).resolves.toMatchObject({
      id: 'target',
    });

    prisma.circleMember.findFirst.mockResolvedValue(null);
    prisma.chatMember.findMany.mockResolvedValue([
      {
        role: 'MEMBER',
        conversation: {
          ownerID: 'owner-9',
          membersCanViewProfiles: true,
          membersCanAddFriends: false,
        },
      },
    ]);
    await expect(service.findOne('target', 'viewer')).resolves.toMatchObject({
      id: 'target',
    });
  });

  it('never gates the user against themselves, and skips the gate for anonymous reads', async () => {
    prisma.chatMember.findMany.mockResolvedValue(closedSharedGroup);
    await expect(service.findOne('target', 'target')).resolves.toMatchObject({
      id: 'target',
    });
    expect(prisma.chatMember.findMany).not.toHaveBeenCalled();

    await expect(service.findOne('target')).resolves.toMatchObject({
      id: 'target',
    });
    expect(prisma.chatMember.findMany).not.toHaveBeenCalled();
  });
});
