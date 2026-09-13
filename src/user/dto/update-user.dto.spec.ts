import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateUserDto } from './update-user.dto';

function build(payload: Record<string, unknown>) {
  return validateSync(plainToInstance(UpdateUserDto, payload));
}

// Mirrors the global ValidationPipe options (src/setup.ts): unknown properties
// are rejected, not silently stripped.
function buildStrict(payload: Record<string, unknown>) {
  return validateSync(plainToInstance(UpdateUserDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('UpdateUserDto', () => {
  it('accepts local development asset URLs for avatar fields', () => {
    const errors = build({
      avatarUrl: 'http://localhost:9000/circle/avatars/test.jpg',
      avatarFrame: 'http://localhost:9000/circle/frames/test.png',
      cover: 'http://localhost:9000/circle/covers/test.png',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects javascript: URLs in avatar fields', () => {
    const errors = build({ avatarUrl: 'javascript:alert(1)' });
    const target = errors.find((e) => e.property === 'avatarUrl');
    expect(target).toBeDefined();
    expect(target?.constraints).toHaveProperty('isUrl');
  });

  it('rejects relative paths without a protocol', () => {
    const errors = build({ avatarUrl: '/no-protocol/path.png' });
    const target = errors.find((e) => e.property === 'avatarUrl');
    expect(target?.constraints).toHaveProperty('isUrl');
  });

  it('rejects overlong nickname', () => {
    const errors = build({ nickname: 'x'.repeat(51) });
    const target = errors.find((e) => e.property === 'nickname');
    expect(target?.constraints).toHaveProperty('isLength');
  });

  it('rejects a blank nickname', () => {
    const errors = build({ nickname: '' });
    const target = errors.find((e) => e.property === 'nickname');
    expect(target?.constraints).toHaveProperty('isLength');
  });

  it('rejects a whitespace-only nickname', () => {
    const errors = build({ nickname: '   ' });
    const target = errors.find((e) => e.property === 'nickname');
    expect(target?.constraints).toHaveProperty('isLength');
  });

  it('trims surrounding whitespace from a nickname', () => {
    const dto = plainToInstance(UpdateUserDto, { nickname: '  Jim  ' });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.nickname).toBe('Jim');
  });

  // email 是登录身份而非资料字段：能改邮箱就能走找回密码接管账号。
  // 前端资料编辑本来就不发它；服务端必须把它当成未知属性拒绝。
  it('rejects email as a non-whitelisted property under the global pipe options', () => {
    const errors = buildStrict({ email: 'a@b.co' });
    const target = errors.find((e) => e.property === 'email');
    expect(target?.constraints).toHaveProperty('whitelistValidation');
  });

  it('still accepts whitelisted profile fields under the strict pipe options', () => {
    expect(buildStrict({ nickname: 'ok' })).toHaveLength(0);
  });

  it('rejects malformed birthday string', () => {
    const errors = build({ birthday: 'yesterday' });
    const target = errors.find((e) => e.property === 'birthday');
    expect(target?.constraints).toHaveProperty('isDateString');
  });

  it('rejects invalid gender enum', () => {
    const errors = build({ gender: 'attack-helicopter' });
    const target = errors.find((e) => e.property === 'gender');
    expect(target?.constraints).toHaveProperty('isEnum');
  });

  it('accepts an empty payload (all fields optional)', () => {
    const errors = build({});
    expect(errors).toHaveLength(0);
  });

  it('accepts a valid region', () => {
    const errors = build({ region: '上海' });
    expect(errors).toHaveLength(0);
  });

  it('rejects overlong region', () => {
    const errors = build({ region: 'x'.repeat(101) });
    const target = errors.find((e) => e.property === 'region');
    expect(target?.constraints).toHaveProperty('maxLength');
  });

  it('rejects non-string region', () => {
    const errors = build({ region: 123 });
    const target = errors.find((e) => e.property === 'region');
    expect(target?.constraints).toHaveProperty('isString');
  });
});

// 与全局 ValidationPipe 同一组选项（src/setup.ts）：隐式转换对 null 原样放行。
function validateLikePipe(payload: Record<string, unknown>) {
  return validateSync(
    plainToInstance(UpdateUserDto, payload, { enableImplicitConversion: true }),
    { whitelist: true, forbidNonWhitelisted: true },
  );
}

// nickname / gender 是非空列：@IsOptional 让 { "nickname": null } 过了管道，
// 落到 Prisma 才炸成 PrismaClientValidationError → 500（外加一条 Sentry）。
describe('UpdateUserDto null handling', () => {
  it.each(['nickname', 'gender'])(
    'rejects an explicit null %s at the validation layer',
    (property) => {
      const target = validateLikePipe({ [property]: null }).find(
        (error) => error.property === property,
      );
      expect(target?.constraints).toHaveProperty('isDefined');
    },
  );

  it('still treats an omitted nickname / gender as "leave unchanged"', () => {
    expect(validateLikePipe({ persona: 'hi' })).toHaveLength(0);
  });

  // 可空列上 null 就是「清空」（空串同理，见 service 的 BLANKABLE_TEXT_FIELDS）。
  it.each([
    'avatarUrl',
    'avatarFrame',
    'cover',
    'phoneNumber',
    'wechat',
    'qq',
    'whatsup',
    'persona',
    'helloWords',
    'birthday',
    'city',
    'region',
  ])('keeps accepting null for the nullable column %s', (property) => {
    expect(validateLikePipe({ [property]: null })).toHaveLength(0);
  });
});
