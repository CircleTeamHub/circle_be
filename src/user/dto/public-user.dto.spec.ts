import { plainToInstance } from 'class-transformer';
import { PublicUserDto, SelfUserDto } from './public-user.dto';

describe('SelfUserDto serialization', () => {
  const passwordHashFixture = ['argon2', 'hash'].join('-');

  it('keeps nested display icon fields when excludeExtraneousValues is enabled', () => {
    const dto = plainToInstance(
      SelfUserDto,
      {
        id: 'user-1',
        accountId: 'jimmy',
        inviteCode: 'invite1',
        nickname: 'meiguici',
        avatarUrl: null,
        avatarFrame: null,
        cover: null,
        wechat: null,
        qq: null,
        whatsup: null,
        persona: null,
        helloWords: null,
        birthday: null,
        gender: 'male',
        city: '张家口',
        role: 'USER',
        status: 'ACTIVE',
        lastOnline: null,
        createdAt: new Date('2026-04-09T02:01:09.078Z'),
        updatedAt: new Date('2026-04-24T02:52:34.270Z'),
        email: null,
        phoneNumber: null,
        vipLevel: 5,
        storedVipLevel: 5,
        vipExpiresAt: null,
        membership: {
          effectiveLevel: 4,
          key: 'super',
          appearance: {
            nameColor: 'exclusive-shimmer',
            badge: 'super-lifetime',
          },
          active: true,
          lifetime: true,
        },
        creditScore: 100,
        displayIcons: [
          {
            id: 'icon-1',
            type: 'SYSTEM',
            title: 'VIP5',
            imageUrl: null,
            fallbackIconName: 'diamond',
            systemKey: 'VIP',
            recognitionCount: 100,
            sortOrder: 0,
          },
        ],
      },
      {
        excludeExtraneousValues: true,
      },
    );

    expect(dto.displayIcons).toEqual([
      expect.objectContaining({
        id: 'icon-1',
        type: 'SYSTEM',
        title: 'VIP5',
        fallbackIconName: 'diamond',
        systemKey: 'VIP',
        recognitionCount: 100,
        sortOrder: 0,
      }),
    ]);
    expect(dto.inviteCode).toBe('invite1');
    expect(dto.storedVipLevel).toBe(5);
    expect(dto.membership).toEqual({
      effectiveLevel: 4,
      key: 'super',
      appearance: {
        nameColor: 'exclusive-shimmer',
        badge: 'super-lifetime',
      },
      active: true,
      lifetime: true,
    });
  });

  it('exposes region (inherited from PublicUserDto) and strips unknown/sensitive fields', () => {
    const dto = plainToInstance(
      SelfUserDto,
      {
        id: 'user-1',
        city: '杭州',
        region: '上海',
        // Sensitive columns that must never leak through the response DTO.
        passwordHash: passwordHashFixture,
        vipLevel: 3,
        vipExpiresAt: new Date('2026-05-01T00:00:00.000Z'),
        membership: {
          effectiveLevel: 3,
          key: 'diamond',
          appearance: { nameColor: 'rainbow', badge: 'diamond' },
        },
        inviteCode: 'private1',
        openimSynced: true,
      } as Record<string, unknown>,
      { excludeExtraneousValues: true },
    );

    const leaked = dto as unknown as Record<string, unknown>;
    expect(dto.region).toBe('上海');
    expect(dto.city).toBe('杭州');
    expect(leaked.passwordHash).toBeUndefined();
    expect(leaked.openimSynced).toBeUndefined();
  });
});

describe('PublicUserDto serialization (other-user view)', () => {
  const passwordHashFixture = ['argon2', 'hash'].join('-');

  it('exposes region and city publicly, but never leaks PII or secrets', () => {
    const dto = plainToInstance(
      PublicUserDto,
      {
        id: 'user-1',
        accountId: 'jimmy',
        nickname: 'meiguici',
        city: '杭州',
        region: '上海',
        // None of these may appear in the public (other-user) view.
        email: 'secret@example.com',
        phoneNumber: '+8613800138000',
        passwordHash: passwordHashFixture,
        vipLevel: 3,
        vipExpiresAt: new Date('2026-05-01T00:00:00.000Z'),
        membership: {
          effectiveLevel: 3,
          key: 'diamond',
          appearance: { nameColor: 'rainbow', badge: 'diamond' },
        },
      } as Record<string, unknown>,
      { excludeExtraneousValues: true },
    );

    const view = dto as unknown as Record<string, unknown>;
    // region/city are intentionally public — same visibility as city (product decision).
    expect(view.region).toBe('上海');
    expect(view.city).toBe('杭州');
    // PublicUserDto is the "no PII" view; PII and secrets must stay out.
    expect(view.email).toBeUndefined();
    expect(view.phoneNumber).toBeUndefined();
    expect(view.passwordHash).toBeUndefined();
    expect(view.inviteCode).toBeUndefined();
    expect(view.vipLevel).toBeUndefined();
    expect(view.vipExpiresAt).toBeUndefined();
    expect(dto.membership).toEqual({
      effectiveLevel: 3,
      key: 'diamond',
      appearance: { nameColor: 'rainbow', badge: 'diamond' },
    });
  });
});
