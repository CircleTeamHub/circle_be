export const CUSTOM_FANCY_NUMBER_PATTERN = /^[A-Z0-9]{6}$/;
export const CUSTOM_FANCY_NUMBER_RULE_MESSAGE = '靓号必须是 6 位英文字母或数字';

const RESERVED_PREFIXES = [
  'ADMIN',
  'GOVERN',
  'OFFICI',
  'POLICE',
  'SERVIC',
  'SUPPOR',
  'SYSTEM',
] as const;

export function normalizeCustomFancyNumber(value: string): {
  displayValue: string;
  storedValue: string;
} {
  const displayValue = value.trim().toUpperCase();
  return { displayValue, storedValue: displayValue.toLowerCase() };
}

export function validateCustomFancyNumber(value: string): {
  displayValue: string;
  storedValue: string;
} {
  const normalized = normalizeCustomFancyNumber(value);
  if (!CUSTOM_FANCY_NUMBER_PATTERN.test(normalized.displayValue)) {
    throw new Error(CUSTOM_FANCY_NUMBER_RULE_MESSAGE);
  }
  if (
    RESERVED_PREFIXES.some((prefix) =>
      normalized.displayValue.startsWith(prefix),
    )
  ) {
    throw new Error('该靓号不可使用');
  }
  return normalized;
}
