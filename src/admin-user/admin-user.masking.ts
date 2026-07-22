import { SensitiveField } from './admin-user.constants';

export function maskSensitiveField(
  field: SensitiveField,
  value: string | null,
): string | null {
  if (value === null) {
    return null;
  }

  if (field === 'email') {
    const atIndex = value.indexOf('@');
    return atIndex > 0 ? `${value[0]}***${value.slice(atIndex)}` : '**';
  }

  if (field === 'phoneNumber') {
    if (value.length <= 4) {
      return '**';
    }
    return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
  }

  if (value.length <= 2) {
    return '**';
  }

  return `${value[0]}***${value[value.length - 1]}`;
}
