import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  RegisterPushTokenDto,
  RevokePushTokenDto,
  UpdateCirclePushPreferenceDto,
} from './notification.dto';

describe('push token DTOs', () => {
  const registration = (overrides: Record<string, unknown> = {}) =>
    plainToInstance(RegisterPushTokenDto, {
      token: 'ExponentPushToken[abc]',
      platform: 'ios',
      provider: 'expo',
      ...overrides,
    });

  it('keeps revocation secrets optional for legacy registration clients', () => {
    expect(validateSync(registration())).toHaveLength(0);
  });

  it('accepts registration revocation secrets from 32 through 256 characters', () => {
    expect(
      validateSync(registration({ revocationSecret: 'a'.repeat(32) })),
    ).toHaveLength(0);
    expect(
      validateSync(registration({ revocationSecret: 'b'.repeat(256) })),
    ).toHaveLength(0);
  });

  it('rejects registration revocation secrets outside the length bounds', () => {
    for (const revocationSecret of ['a'.repeat(31), 'b'.repeat(257)]) {
      expect(
        validateSync(registration({ revocationSecret })).map(
          (error) => error.property,
        ),
      ).toContain('revocationSecret');
    }
  });

  it('requires a bounded token and revocation secret for public revocation', () => {
    const valid = plainToInstance(RevokePushTokenDto, {
      token: 'ExponentPushToken[abc]',
      revocationSecret: 's'.repeat(32),
    });
    expect(validateSync(valid)).toHaveLength(0);

    const missing = plainToInstance(RevokePushTokenDto, {});
    expect(
      validateSync(missing)
        .map((error) => error.property)
        .sort(),
    ).toEqual(['revocationSecret', 'token']);

    const invalid = plainToInstance(RevokePushTokenDto, {
      token: 't'.repeat(513),
      revocationSecret: 's'.repeat(31),
    });
    expect(
      validateSync(invalid)
        .map((error) => error.property)
        .sort(),
    ).toEqual(['revocationSecret', 'token']);
  });
});

describe('push token shape validation (#98)', () => {
  const registration = (token: string) =>
    plainToInstance(RegisterPushTokenDto, {
      token,
      platform: 'ios' as const,
      provider: 'expo' as const,
    });

  it('accepts both Expo push token spellings', () => {
    expect(
      validateSync(registration('ExponentPushToken[abc-DEF_123]')),
    ).toHaveLength(0);
    expect(validateSync(registration('ExpoPushToken[abc]'))).toHaveLength(0);
  });

  it('rejects junk that is not an Expo push token', () => {
    for (const junk of [
      'not-a-token',
      'ExponentPushToken[]',
      'ExponentPushToken[with space]',
      'fcm:abcdef',
      'ExponentPushToken[abc', // 未闭合
    ]) {
      expect(validateSync(registration(junk)).map((e) => e.property)).toContain(
        'token',
      );
    }
  });
});

describe('UpdateCirclePushPreferenceDto', () => {
  // 全局 ValidationPipe 开着 enableImplicitConversion（src/setup.ts），它跑在
  // 校验之前，会把任意非空字符串转成 true。plainToInstance 带上同一个选项，
  // 测的才是线上那条路径。
  const parse = (value: unknown) =>
    plainToInstance(
      UpdateCirclePushPreferenceDto,
      { circleOfflinePushEnabled: value },
      { enableImplicitConversion: true },
    );

  it('接受真正的布尔值', () => {
    for (const value of [true, false]) {
      const dto = parse(value);
      expect(validateSync(dto)).toHaveLength(0);
      expect(dto.circleOfflinePushEnabled).toBe(value);
    }
  });

  // 这才是这个开关最要命的输入：`"false"` 被隐式转换成 true，用户以为关掉了
  // 离线提醒、服务端照推不误 —— 而关掉它正是这个接口存在的唯一理由。
  it('拒绝会被隐式转换成 true 的字符串', () => {
    for (const value of ['false', '0', 'true', '1', 'no']) {
      expect(
        validateSync(parse(value)).map((error) => error.property),
      ).toContain('circleOfflinePushEnabled');
    }
  });

  it('拒绝数字、null 与缺字段', () => {
    for (const value of [0, 1, null, undefined]) {
      expect(
        validateSync(parse(value)).map((error) => error.property),
      ).toContain('circleOfflinePushEnabled');
    }
    expect(
      validateSync(
        plainToInstance(
          UpdateCirclePushPreferenceDto,
          {},
          { enableImplicitConversion: true },
        ),
      ).map((error) => error.property),
    ).toContain('circleOfflinePushEnabled');
  });
});
