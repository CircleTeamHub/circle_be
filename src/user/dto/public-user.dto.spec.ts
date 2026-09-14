import { plainToInstance } from 'class-transformer';
import { ProfileUserDto, PublicUserDto, SelfUserDto } from './public-user.dto';

type Loose = Record<string, unknown>;

// 一份「后端能拼出来的最全的 user 对象」：自视图应露出的、他人视图必须剥掉的、
// 以及谁都不该看到的字段全在里面，三个 DTO 各自过一遍 excludeExtraneousValues。
const FULL_USER: Loose = {
  id: 'user-1',
  accountId: 'jimmy',
  inviteCode: 'invite1',
  nickname: 'meiguici',
  avatarUrl: null,
  avatarFrame: null,
  avatarFrameAppearance: {
    id: 'frame-1',
    key: 'membership-diamond',
    name: 'Diamond frame',
    imageUrl: 'https://cdn.example/frame.png',
    internalOnly: 'strip-me',
  },
  cover: null,
  wechat: null,
  qq: null,
  whatsup: null,
  persona: null,
  helloWords: null,
  birthday: null,
  gender: 'male',
  city: '张家口',
  region: '河北',
  role: 'ADMIN',
  status: 'ACTIVE',
  lastOnline: null,
  createdAt: new Date('2026-04-09T02:01:09.078Z'),
  updatedAt: new Date('2026-04-24T02:52:34.270Z'),
  email: 'secret@example.com',
  phoneNumber: '+8613800138000',
  vipLevel: 4,
  storedVipLevel: 5,
  vipExpiresAt: new Date('2026-05-01T00:00:00.000Z'),
  membership: {
    effectiveLevel: 4,
    key: 'super',
    appearance: { nameColor: 'exclusive-shimmer', badge: 'super-lifetime' },
    active: true,
    lifetime: true,
  },
  creditScore: 100,
  receivedLikeCount: 1,
  fancyNumber: true,
  likeCount: 12,
  likedByMeToday: true,
  passwordHash: ['argon2', 'hash'].join('-'),
  openimSynced: true,
  displayIcons: [
    {
      id: 'icon-1',
      type: 'SYSTEM',
      title: 'VIP4',
      imageUrl: null,
      fallbackIconName: 'diamond',
      systemKey: 'VIP',
      recognitionCount: 100,
      sortOrder: 0,
    },
  ],
};

function serialize<T>(dto: new () => T, overrides: Loose = {}): T & Loose {
  return plainToInstance(
    dto,
    { ...FULL_USER, ...overrides },
    { excludeExtraneousValues: true },
  ) as T & Loose;
}

describe('SelfUserDto serialization (/auth/me, PATCH /user/:id)', () => {
  it('keeps nested display icon fields when excludeExtraneousValues is enabled', () => {
    const dto = serialize(SelfUserDto);

    expect(dto.displayIcons).toEqual([
      expect.objectContaining({
        id: 'icon-1',
        type: 'SYSTEM',
        title: 'VIP4',
        fallbackIconName: 'diamond',
        systemKey: 'VIP',
        recognitionCount: 100,
        sortOrder: 0,
      }),
    ]);
    expect(dto.inviteCode).toBe('invite1');
    expect(dto.vipLevel).toBe(4);
    expect(dto.creditScore).toBe(100);
    expect(dto.receivedLikeCount).toBe(1);
  });

  // 账号自己的 role/status 是管理台登录门（RequireAdmin / LoginPage 只读 /auth/me），
  // 留在自视图；靓号标记是客户端 feature flag 后面的自视图字段。
  it('exposes role, status and fancyNumber to the account owner', () => {
    const dto = serialize(SelfUserDto);

    expect(dto.role).toBe('ADMIN');
    expect(dto.status).toBe('ACTIVE');
    expect(dto.fancyNumber).toBe(true);
  });

  // 靓号租约到期是惰性回收的（fancy-number 流程碰到才 expireLease），列上的
  // fancyNumber 在那之前仍是 true。广场与圈子准入都走 resolveEffectiveFancyNumber，
  // 自视图不能把过期租约报成有效；租期两列本身只用于判定，不外露。
  it('resolves fancyNumber through the lease rules instead of echoing the raw column', () => {
    const expired = serialize(SelfUserDto, {
      fancyNumber: true,
      fancyNumberPermanent: false,
      fancyNumberExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const leased = serialize(SelfUserDto, {
      fancyNumber: true,
      fancyNumberPermanent: false,
      fancyNumberExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
    });
    const permanent = serialize(SelfUserDto, {
      fancyNumber: true,
      fancyNumberPermanent: true,
      fancyNumberExpiresAt: null,
    });
    const none = serialize(SelfUserDto, { fancyNumber: false });

    expect(expired.fancyNumber).toBe(false);
    expect(leased.fancyNumber).toBe(true);
    expect(permanent.fancyNumber).toBe(true);
    expect(none.fancyNumber).toBe(false);
    expect(expired.fancyNumberExpiresAt).toBeUndefined();
    expect(expired.fancyNumberPermanent).toBeUndefined();
  });

  // storedVipLevel / vipExpiresAt / membership / region：APP 与管理台没有任何
  // 页面读它们（normalizeUser 也不拷贝），纯粹是响应里的死重量。
  it('no longer carries the unread membership internals or region', () => {
    const dto = serialize(SelfUserDto);

    expect(dto.storedVipLevel).toBeUndefined();
    expect(dto.vipExpiresAt).toBeUndefined();
    expect(dto.membership).toBeUndefined();
    expect(dto.region).toBeUndefined();
  });

  it('strips unknown / sensitive columns', () => {
    const dto = serialize(SelfUserDto);

    expect(dto.city).toBe('张家口');
    expect(dto.passwordHash).toBeUndefined();
    expect(dto.openimSynced).toBeUndefined();
  });
});

describe('PublicUserDto serialization (account search, other-user view)', () => {
  it('exposes the public display fields only', () => {
    const dto = serialize(PublicUserDto);

    expect(dto.city).toBe('张家口');
    expect(dto.vipLevel).toBe(4);
    expect(dto.avatarFrameAppearance).toEqual({
      id: 'frame-1',
      key: 'membership-diamond',
      name: 'Diamond frame',
      imageUrl: 'https://cdn.example/frame.png',
    });
  });

  // role/status 出现在他人视图上等于让任何登录用户扫出管理员账号；
  // 搜索接口同时必须保持无联系方式。
  it('never leaks role, status, PII, secrets or membership internals', () => {
    const dto = serialize(PublicUserDto);

    expect(dto.role).toBeUndefined();
    expect(dto.status).toBeUndefined();
    expect(dto.email).toBeUndefined();
    expect(dto.phoneNumber).toBeUndefined();
    expect(dto.passwordHash).toBeUndefined();
    expect(dto.inviteCode).toBeUndefined();
    expect(dto.fancyNumber).toBeUndefined();
    expect(dto.vipExpiresAt).toBeUndefined();
    expect(dto.storedVipLevel).toBeUndefined();
    expect(dto.membership).toBeUndefined();
    expect(dto.region).toBeUndefined();
  });
});

describe('ProfileUserDto serialization (GET /user/:id)', () => {
  it('keeps the like count and the privacy-gated contact fields', () => {
    const dto = serialize(ProfileUserDto);

    expect(dto.likeCount).toBe(12);
    // 服务层按 showPhone/showEmail 已经把不该看的置 null，DTO 只负责放行。
    expect(dto.email).toBe('secret@example.com');
    expect(dto.phoneNumber).toBe('+8613800138000');
  });

  it('inherits the public view: no role/status/membership/region, no likedByMeToday', () => {
    const dto = serialize(ProfileUserDto);

    expect(dto.role).toBeUndefined();
    expect(dto.status).toBeUndefined();
    expect(dto.membership).toBeUndefined();
    expect(dto.region).toBeUndefined();
    expect(dto.likedByMeToday).toBeUndefined();
    expect(dto.inviteCode).toBeUndefined();
  });
});
