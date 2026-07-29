import {
  normalizeCustomFancyNumber,
  validateCustomFancyNumber,
} from './fancy-number.rules';

describe('custom fancy-number rules', () => {
  it('normalizes six alphanumeric characters for display and storage', () => {
    expect(normalizeCustomFancyNumber(' ab12c3 ')).toEqual({
      displayValue: 'AB12C3',
      storedValue: 'ab12c3',
    });
  });

  it.each(['ABC12', 'ABC1234', 'ABC-12', '你好12AB'])(
    'rejects an invalid custom fancy number: %s',
    (value) => {
      expect(() => validateCustomFancyNumber(value)).toThrow(
        '靓号必须是 6 位英文字母或数字',
      );
    },
  );

  it.each(['ADMIN1', 'SYSTEM', 'SUPPOR'])(
    'rejects a reserved or impersonating value: %s',
    (value) => {
      expect(() => validateCustomFancyNumber(value)).toThrow('该靓号不可使用');
    },
  );
});
