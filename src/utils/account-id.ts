import { randomBytes } from 'crypto';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function generateAccountId(): string {
  const bytes = randomBytes(6);
  const suffix = Array.from(bytes)
    .map((b) => CHARS[b % CHARS.length])
    .join('');
  return `ACC_${suffix}`;
}
