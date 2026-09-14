import { plainToInstance } from 'class-transformer';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { ProfileUserDto, PublicUserDto } from './dto/public-user.dto';
import { UserService } from './user.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';

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
  const privacySettings = { canViewProfileFields: jest.fn() };
  /** 按字段给出可见性，替身 PrivacySettingsService.canViewProfileFields。 */
  const allowProfileFields = (visible: (field: string) => boolean) =>
    privacySettings.canViewProfileFields.mockImplementation(
      async (_id: string, fields: readonly string[]) =>
        Object.fromEntries(fields.map((field) => [field, visible(field)])),
    );

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
    allowProfileFields(() => false);
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

  it('nulls email for other viewers unless the target enabled showEmail', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'target',
      nickname: '目标',
      avatarUrl: null,
      phoneNumber: null,
      email: 'target@example.com',
      wechat: null,
      qq: null,
      whatsup: null,
      receivedLikeCount: 3,
    });

    await expect(service.findOne('target', 'viewer')).resolves.toMatchObject({
      email: null,
    });

    allowProfileFields((field) => field === 'email');
    await expect(service.findOne('target', 'viewer')).resolves.toMatchObject({
      email: 'target@example.com',
    });
    expect(privacySettings.canViewProfileFields).toHaveBeenCalledWith(
      'target',
      expect.arrayContaining(['email']),
      false,
      false,
    );
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

// 「显示邮箱」开关此前是个空操作：service 已按 showEmail 把 email 置空/保留，
// 但 GET /user/:id 序列化用的 ProfileUserDto 根本没有 email 字段，开了也看不到。
describe('ProfileUserDto email exposure (showEmail toggle)', () => {
  it('keeps email on the profile view so the privacy toggle has an effect', () => {
    const dto = plainToInstance(
      ProfileUserDto,
      { id: 'target', email: 'target@example.com' },
      { excludeExtraneousValues: true },
    );
    expect(dto.email).toBe('target@example.com');
  });

  it('still strips email from PublicUserDto (account search must stay email-free)', () => {
    const dto = plainToInstance(
      PublicUserDto,
      { id: 'target', email: 'target@example.com' },
      { excludeExtraneousValues: true },
    );
    expect((dto as unknown as Record<string, unknown>).email).toBeUndefined();
  });
});

// 资料页每次要判六个隐私字段。用真实的 PrivacySettingsService 数 userPrivacySetting
// 的读取次数，钉住「一次资料访问只读一次对方的隐私设置」，同时核对判定结果不变。
describe('UserService.findOne privacy settings reads', () => {
  it('loads the target privacy settings once per profile view', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'target',
          nickname: '目标',
          phoneNumber: '13800000000',
          email: 'target@example.com',
          wechat: 'wx-target',
          qq: '10001',
          whatsup: 'hi',
          lastOnline: new Date('2026-09-11T08:00:00.000Z'),
          receivedLikeCount: 3,
        }),
      },
      userPrivacySetting: {
        findUnique: jest.fn().mockResolvedValue({
          userID: 'target',
          showPhone: true,
          showEmail: false,
          showWechat: true,
          showQQ: false,
          showWhatsup: true,
          shareOnlineStatus: false,
        }),
      },
      chatMember: { findMany: jest.fn().mockResolvedValue([]) },
      friend: { findFirst: jest.fn().mockResolvedValue(null) },
      circleMember: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const privacySettings = new PrivacySettingsService(
      prisma as never,
      {} as never,
      {} as never,
    );
    const service = new UserService(
      prisma as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      {} as never,
      { getDisplayIconsForUser: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      privacySettings,
      {
        resolvePublicAppearances: jest.fn().mockResolvedValue(new Map()),
      } as never,
    );

    await expect(service.findOne('target', 'viewer')).resolves.toMatchObject({
      phoneNumber: '13800000000',
      email: null,
      wechat: 'wx-target',
      qq: null,
      whatsup: 'hi',
      lastOnline: null,
    });
    expect(prisma.userPrivacySetting.findUnique).toHaveBeenCalledTimes(1);
  });
});
