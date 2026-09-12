import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdatePrivacySettingsDto } from './privacy-settings.dto';
import { PrivacySettingsService } from './privacy-settings.service';
import {
  PRESENCE_VISIBILITY_CHANGED,
  privacySettingsEvents,
} from './privacy-events';

describe('PrivacySettingsService', () => {
  const prisma = {
    userPrivacySetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(async (input: any) => input(prisma)),
  };
  const sensitiveWords = { check: jest.fn() };

  let service: PrivacySettingsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (input: any) => input(prisma));
    sensitiveWords.check.mockReturnValue({ blocked: false });
    service = new PrivacySettingsService(
      prisma as any,
      sensitiveWords as any,
      { isEnabled: () => false, publish: async () => true } as any,
    );
  });

  it('returns default account privacy settings without writing when none exist', async () => {
    prisma.userPrivacySetting.findUnique.mockResolvedValue(null);

    await expect(service.getSettings('user-1')).resolves.toMatchObject({
      // 全局阅后即焚默认关闭:绝大多数用户库里没有这行,走的就是这份默认值。
      // 默认非 0 等于替所有从没进过隐私设置的人开了「只看得到最近 N 天」。
      messageSelfDestructSec: 0,
      momentsVisibility: 'ALL',
      allowStrangerMessages: true,
      showPhone: false,
      // 注册邮箱是账号找回入口 —— 存量行没有这一列时也必须落到隐藏,
      // 否则一次「读默认值」就把 email 重新放回所有陌生人的资料页。
      showEmail: false,
      showWechat: true,
      showQQ: true,
      showWhatsup: true,
      addMeByAccount: true,
      addMeByPhone: false,
      addMeByQrCode: true,
      addMeByGroup: true,
      callPermission: 'EVERYONE',
      groupInvitePermission: 'EVERYONE',
      directMessageAutoReplyEnabled: false,
      directMessageAutoReplyText: '',
      // 在线状态与输入状态默认外露 —— 上线前本来就对所有会话成员可见。
      shareOnlineStatus: true,
      shareTypingInDirect: true,
      shareTypingInGroup: true,
    });

    // A read must never write: lazily creating a row here would let any
    // stranger viewing a profile trigger a write to the target's row.
    expect(prisma.userPrivacySetting.upsert).not.toHaveBeenCalled();

    // 默认值必须一路走到字段闸门,不只是 DTO 上好看。
    await expect(
      service.canViewProfileField('user-1', 'email', false, false),
    ).resolves.toBe(false);
    await expect(
      service.canViewProfileField('user-1', 'email', true, false),
    ).resolves.toBe(true);
  });

  it('trims and persists account-synced direct-message auto reply settings', async () => {
    prisma.userPrivacySetting.upsert.mockResolvedValue({
      userID: 'user-1',
      directMessageAutoReplyEnabled: true,
      directMessageAutoReplyText: '稍后回复',
    });

    await expect(
      service.updateSettings('user-1', {
        directMessageAutoReplyEnabled: true,
        directMessageAutoReplyText: '  稍后回复  ',
      }),
    ).resolves.toMatchObject({
      directMessageAutoReplyEnabled: true,
      directMessageAutoReplyText: '稍后回复',
    });

    expect(prisma.userPrivacySetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          directMessageAutoReplyEnabled: true,
          directMessageAutoReplyText: '稍后回复',
        }),
      }),
    );
  });

  it('validates direct-message auto reply text at both DTO and service boundaries', async () => {
    const tooLong = 'x'.repeat(201);
    const dtoErrors = validateSync(
      plainToInstance(UpdatePrivacySettingsDto, {
        directMessageAutoReplyEnabled: true,
        directMessageAutoReplyText: tooLong,
      }),
    );

    expect(
      dtoErrors.some(
        (error) => error.property === 'directMessageAutoReplyText',
      ),
    ).toBe(true);
    await expect(
      service.updateSettings('user-1', {
        directMessageAutoReplyText: tooLong,
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.updateSettings('user-1', {
        directMessageAutoReplyEnabled: 'yes' as never,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects sensitive direct-message auto reply text before persistence', async () => {
    sensitiveWords.check.mockReturnValue({ blocked: true, word: 'blocked' });

    await expect(
      service.updateSettings('user-1', {
        directMessageAutoReplyEnabled: true,
        directMessageAutoReplyText: 'contains blocked content',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.userPrivacySetting.upsert).not.toHaveBeenCalled();
  });

  it('rejects enabling direct-message auto reply with blank text', async () => {
    prisma.userPrivacySetting.findUnique.mockResolvedValue(null);

    await expect(
      service.updateSettings('user-1', {
        directMessageAutoReplyEnabled: true,
        directMessageAutoReplyText: '   ',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.userPrivacySetting.upsert).not.toHaveBeenCalled();
  });

  it('validates partial auto-reply updates against the stored final state', async () => {
    prisma.userPrivacySetting.findUnique.mockResolvedValue({
      userID: 'user-1',
      directMessageAutoReplyEnabled: false,
      directMessageAutoReplyText: '',
    });

    await expect(
      service.updateSettings('user-1', {
        directMessageAutoReplyEnabled: true,
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.userPrivacySetting.upsert).not.toHaveBeenCalled();
  });

  it('allows disabling auto reply and clearing its draft text', async () => {
    prisma.userPrivacySetting.findUnique.mockResolvedValue({
      userID: 'user-1',
      directMessageAutoReplyEnabled: true,
      directMessageAutoReplyText: '稍后回复',
    });
    prisma.userPrivacySetting.upsert.mockResolvedValue({
      userID: 'user-1',
      directMessageAutoReplyEnabled: false,
      directMessageAutoReplyText: '',
    });

    await expect(
      service.updateSettings('user-1', {
        directMessageAutoReplyEnabled: false,
        directMessageAutoReplyText: '',
      }),
    ).resolves.toMatchObject({
      directMessageAutoReplyEnabled: false,
      directMessageAutoReplyText: '',
    });
  });

  it('rejects string booleans under the production implicit-conversion pipe', () => {
    for (const raw of ['false', 'true', '0', '1', '']) {
      const dto = plainToInstance(
        UpdatePrivacySettingsDto,
        { directMessageAutoReplyEnabled: raw },
        { enableImplicitConversion: true },
      );
      expect(
        validateSync(dto).some(
          (error) => error.property === 'directMessageAutoReplyEnabled',
        ),
      ).toBe(true);
    }
  });

  it('rejects non-string reply text under the production implicit-conversion pipe', () => {
    for (const raw of [123, false, { text: 'hello' }]) {
      const dto = plainToInstance(
        UpdatePrivacySettingsDto,
        { directMessageAutoReplyText: raw },
        { enableImplicitConversion: true },
      );
      expect(
        validateSync(dto).some(
          (error) => error.property === 'directMessageAutoReplyText',
        ),
      ).toBe(true);
    }
  });

  it('counts Unicode code points consistently with varchar(200)', async () => {
    const twoHundredEmoji = '😀'.repeat(200);
    prisma.userPrivacySetting.upsert.mockResolvedValue({
      userID: 'user-1',
      directMessageAutoReplyEnabled: true,
      directMessageAutoReplyText: twoHundredEmoji,
    });

    await expect(
      service.updateSettings('user-1', {
        directMessageAutoReplyEnabled: true,
        directMessageAutoReplyText: twoHundredEmoji,
      }),
    ).resolves.toMatchObject({ directMessageAutoReplyText: twoHundredEmoji });
  });

  it('patches only supplied settings and rejects unsupported enum values', async () => {
    await expect(
      service.updateSettings('user-1', {
        momentsVisibility: 'FRIENDS_ONLY',
        callPermission: 'NOPE' as any,
      }),
    ).rejects.toThrow(BadRequestException);

    prisma.userPrivacySetting.upsert.mockResolvedValue({
      userID: 'user-1',
      messageSelfDestructSec: 604800,
      momentsVisibility: 'FRIENDS_ONLY',
      allowStrangerMessages: false,
    });

    await service.updateSettings('user-1', {
      messageSelfDestructSec: 604800,
      momentsVisibility: 'FRIENDS_ONLY',
      allowStrangerMessages: false,
    });

    expect(prisma.userPrivacySetting.upsert).toHaveBeenLastCalledWith({
      where: { userID: 'user-1' },
      create: expect.objectContaining({
        userID: 'user-1',
        messageSelfDestructSec: 604800,
        momentsVisibility: 'FRIENDS_ONLY',
        allowStrangerMessages: false,
      }),
      update: {
        messageSelfDestructSec: 604800,
        momentsVisibility: 'FRIENDS_ONLY',
        allowStrangerMessages: false,
      },
    });
  });

  it('serializes privacy changes with authorization reads for the same user', async () => {
    prisma.userPrivacySetting.upsert.mockResolvedValue({
      userID: 'user-1',
      groupInvitePermission: 'NONE',
    });

    await service.updateSettings('user-1', {
      groupInvitePermission: 'NONE',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledWith(
      expect.anything(),
      'call-user:user-1',
    );
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.userPrivacySetting.upsert.mock.invocationCallOrder[0],
    );
  });

  it('evaluates viewer permissions from account privacy settings', async () => {
    prisma.userPrivacySetting.findUnique.mockResolvedValue({
      userID: 'target-1',
      momentsVisibility: 'FRIENDS_ONLY',
      allowStrangerMessages: false,
      showPhone: false,
      showEmail: false,
      showWechat: true,
      showQQ: false,
      showWhatsup: false,
      groupInvitePermission: 'FRIENDS_ONLY',
      callPermission: 'FRIENDS_ONLY',
    });

    await expect(
      service.canReceiveStrangerMessage('target-1', false),
    ).resolves.toBe(false);
    await expect(
      service.canViewProfileField('target-1', 'phoneNumber', false, false),
    ).resolves.toBe(false);
    await expect(
      service.canViewProfileField('target-1', 'email', false, false),
    ).resolves.toBe(false);
    await expect(
      service.canViewProfileField('target-1', 'wechat', false, false),
    ).resolves.toBe(true);
    await expect(
      service.canViewProfileField('target-1', 'whatsup', false, false),
    ).resolves.toBe(false);
    await expect(
      service.canBeInvitedToGroupOrCircle('target-1', false),
    ).resolves.toBe(false);
    await expect(service.canBeCalled('target-1', true)).resolves.toBe(true);
  });

  describe('getSettingsMany', () => {
    it('returns a map keyed by userID and skips the query when given no ids', async () => {
      await expect(service.getSettingsMany([])).resolves.toEqual(new Map());
      expect(prisma.userPrivacySetting.findMany).not.toHaveBeenCalled();
    });

    it('loads all rows in one query; absent users are simply missing', async () => {
      prisma.userPrivacySetting.findMany.mockResolvedValue([
        { userID: 'a', momentsVisibility: 'PRIVATE' },
      ]);

      const map = await service.getSettingsMany(['a', 'b']);

      expect(prisma.userPrivacySetting.findMany).toHaveBeenCalledTimes(1);
      expect(map.get('a')?.momentsVisibility).toBe('PRIVATE');
      expect(map.has('b')).toBe(false);
    });
  });

  describe('momentsVisibleFor', () => {
    it('always allows the author to see their own moments', () => {
      expect(service.momentsVisibleFor(undefined, true, false)).toBe(true);
    });

    it('defaults to visible when no settings row exists', () => {
      expect(service.momentsVisibleFor(undefined, false, false)).toBe(true);
    });

    it('hides PRIVATE moments from everyone but the author', () => {
      expect(
        service.momentsVisibleFor(
          { momentsVisibility: 'PRIVATE' } as any,
          false,
          true,
        ),
      ).toBe(false);
    });

    it('limits FRIENDS_ONLY moments to friends', () => {
      const settings = { momentsVisibility: 'FRIENDS_ONLY' } as any;
      expect(service.momentsVisibleFor(settings, false, true)).toBe(true);
      expect(service.momentsVisibleFor(settings, false, false)).toBe(false);
    });
  });
});

describe('PrivacySettingsService presence visibility', () => {
  const prisma = {
    userPrivacySetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
    },
    chatMember: { findMany: jest.fn() },
    block: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(async (input: any) => input(prisma)),
  };
  const sensitiveWords = {
    check: jest.fn().mockReturnValue({ blocked: false }),
  };
  let service: PrivacySettingsService;
  let events: unknown[];

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (input: any) => input(prisma));
    prisma.chatMember.findMany.mockResolvedValue([
      { conversationID: 'conv-1' },
    ]);
    prisma.block.findMany.mockResolvedValue([]);
    privacySettingsEvents.removeAllListeners(PRESENCE_VISIBILITY_CHANGED);
    events = [];
    privacySettingsEvents.on(PRESENCE_VISIBILITY_CHANGED, (event) =>
      events.push(event),
    );
    service = new PrivacySettingsService(
      prisma as any,
      sensitiveWords as any,
      { isEnabled: () => false, publish: async () => true } as any,
    );
  });

  afterAll(() => {
    privacySettingsEvents.removeAllListeners(PRESENCE_VISIBILITY_CHANGED);
  });

  it('gates lastOnline behind shareOnlineStatus like the other profile fields', async () => {
    prisma.userPrivacySetting.findUnique.mockResolvedValue({
      userID: 'user-1',
      shareOnlineStatus: false,
    });
    await expect(
      service.canViewProfileField('user-1', 'lastOnline', false, true),
    ).resolves.toBe(false);
    await expect(
      service.canViewProfileField('user-1', 'lastOnline', true, false),
    ).resolves.toBe(true);
  });

  // 关掉要立刻把在线点从对方界面收回,所以翻转必须在事务提交后广播出去;
  // 收件面 = 在座会话,互相拉黑的人剔掉 —— 与网关上下线广播同一条规则。
  it('emits a committed visibility change with the seat rooms and blocked peers', async () => {
    prisma.userPrivacySetting.findUnique.mockResolvedValue({
      userID: 'user-1',
      shareOnlineStatus: true,
    });
    prisma.userPrivacySetting.upsert.mockResolvedValue({
      userID: 'user-1',
      shareOnlineStatus: false,
    });
    prisma.block.findMany.mockResolvedValue([
      { blockerID: 'user-1', blockedID: 'blocked-by-me' },
      { blockerID: 'blocked-me', blockedID: 'user-1' },
    ]);

    await expect(
      service.updateSettings('user-1', { shareOnlineStatus: false }),
    ).resolves.toMatchObject({ shareOnlineStatus: false });

    // 事件只说「这个人的开关变了」,值由广播侧现读 —— 见 privacy-events 的注释。
    expect(events).toEqual([
      {
        userId: 'user-1',
        conversationIds: ['conv-1'],
        excludeUserIds: ['blocked-by-me', 'blocked-me'],
      },
    ]);
  });

  it('stays silent when the switch is re-saved with the same value', async () => {
    prisma.userPrivacySetting.findUnique.mockResolvedValue({
      userID: 'user-1',
      shareOnlineStatus: true,
    });
    prisma.userPrivacySetting.upsert.mockResolvedValue({
      userID: 'user-1',
      shareOnlineStatus: true,
    });

    await service.updateSettings('user-1', { shareOnlineStatus: true });

    expect(events).toEqual([]);
    expect(prisma.chatMember.findMany).not.toHaveBeenCalled();
  });

  // 准备事件的查询抖一下就把整条撤回丢掉的话,设置已提交、而还连着的客户端会
  // 一直挂着旧的在线状态。有界重试把瞬时失败救回来。
  it('retries event preparation so a transient failure still reaches clients', async () => {
    prisma.userPrivacySetting.findUnique.mockResolvedValue({
      userID: 'user-1',
      shareOnlineStatus: true,
    });
    prisma.userPrivacySetting.upsert.mockResolvedValue({
      userID: 'user-1',
      shareOnlineStatus: false,
    });
    prisma.chatMember.findMany
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValue([{ conversationID: 'conv-1' }]);

    await service.updateSettings('user-1', { shareOnlineStatus: false });

    expect(events).toEqual([
      { userId: 'user-1', conversationIds: ['conv-1'], excludeUserIds: [] },
    ]);
  });

  // 持续失败(不是抖一下)时:设置已经提交,不能把它伪装成失败;撤回留给下一次
  // 查询/重连追平 —— 查询侧读的是实时库,所以设置本身是生效的。
  it('does not turn a committed setting into an error when event preparation keeps failing', async () => {
    prisma.userPrivacySetting.findUnique.mockResolvedValue(null);
    prisma.userPrivacySetting.upsert.mockResolvedValue({
      userID: 'user-1',
      shareOnlineStatus: false,
    });
    prisma.chatMember.findMany.mockRejectedValue(new Error('db down'));

    await expect(
      service.updateSettings('user-1', { shareOnlineStatus: false }),
    ).resolves.toMatchObject({ shareOnlineStatus: false });
    expect(events).toEqual([]);
  });
});
