import { maskSensitiveField } from './admin-user.masking';

describe('maskSensitiveField', () => {
  it.each([
    ['email', null, null],
    ['email', 'jim@example.com', 'j***@example.com'],
    ['phoneNumber', '15512345678', '*******5678'],
    ['wechat', 'jimmy', 'j***y'],
    ['qq', '7', '**'],
  ] as const)('masks %s', (field, value, expected) => {
    expect(maskSensitiveField(field, value)).toBe(expected);
  });
});
