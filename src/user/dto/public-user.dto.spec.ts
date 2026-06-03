import { plainToInstance } from 'class-transformer';
import { SelfUserDto } from './public-user.dto';

describe('SelfUserDto serialization', () => {
  it('keeps nested display icon fields when excludeExtraneousValues is enabled', () => {
    const dto = plainToInstance(
      SelfUserDto,
      {
        id: 'user-1',
        accountId: 'jimmy',
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
        creditScore: 100,
        displayIcons: [
          {
            id: 'icon-1',
            type: 'SYSTEM',
            title: 'VIP5',
            imageUrl: null,
            fallbackIconName: 'diamond',
            systemKey: 'VIP',
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
        sortOrder: 0,
      }),
    ]);
  });

  it('exposes region (inherited from PublicUserDto) and strips unknown/sensitive fields', () => {
    const dto = plainToInstance(
      SelfUserDto,
      {
        id: 'user-1',
        city: '杭州',
        region: '上海',
        // Sensitive columns that must never leak through the response DTO.
        passwordHash: 'argon2-hash',
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
