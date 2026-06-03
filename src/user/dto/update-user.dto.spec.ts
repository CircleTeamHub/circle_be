import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateUserDto } from './update-user.dto';

function build(payload: Record<string, unknown>) {
  return validateSync(plainToInstance(UpdateUserDto, payload));
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
    expect(target?.constraints).toHaveProperty('maxLength');
  });

  it('rejects malformed email', () => {
    const errors = build({ email: 'not-an-email' });
    const target = errors.find((e) => e.property === 'email');
    expect(target?.constraints).toHaveProperty('isEmail');
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
