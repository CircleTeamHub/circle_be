import { randomBytes } from 'crypto';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SUFFIX_LENGTH = 6;
// Largest multiple of 36 that fits in a byte. Bytes ≥ this value are
// rejected so the modulo doesn't bias the first four characters of CHARS.
const ACCEPT_THRESHOLD = Math.floor(256 / CHARS.length) * CHARS.length;

export function generateAccountId(): string {
  const suffix: string[] = [];
  while (suffix.length < SUFFIX_LENGTH) {
    // Generate one byte per remaining character; the rejection rate is ~1.5%
    // so a single batch almost always covers the deficit.
    const buf = randomBytes(SUFFIX_LENGTH - suffix.length);
    for (const b of buf) {
      if (b >= ACCEPT_THRESHOLD) continue;
      suffix.push(CHARS[b % CHARS.length]);
      if (suffix.length >= SUFFIX_LENGTH) break;
    }
  }
  return `ACC_${suffix.join('')}`;
}
