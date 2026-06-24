import { randomBytes } from 'crypto';

// accountId（登录 / 好友搜索用的句柄）校验：4-32 位字母、数字、下划线或短横线。
// service 层防御与 DTO 层校验共用同一规则，避免两处独立维护产生漂移。
export const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9_-]{4,32}$/;
export const ACCOUNT_ID_RULE_MESSAGE =
  '账号需为4-32位字母、数字、下划线或短横线';

// accountId 统一以小写存储（规范化大小写），与好友精确查找的
// case-insensitive 行为及 changeAccountId 的小写归一保持一致。
const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
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
  return suffix.join('');
}
