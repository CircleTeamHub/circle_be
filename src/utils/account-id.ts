import { randomBytes } from 'crypto';

// accountId（登录 / 好友搜索用的句柄）校验：4-32 位字母、数字、下划线或短横线。
// service 层防御与 DTO 层校验共用同一规则，避免两处独立维护产生漂移。
export const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9_-]{4,32}$/;
export const ACCOUNT_ID_RULE_MESSAGE =
  '账号需为4-32位字母、数字、下划线或短横线';

const ACCOUNT_ID_CHARS = '0123456789';
const INVITE_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 6;

function generateCode(chars: string): string {
  const result: string[] = [];
  const acceptThreshold = Math.floor(256 / chars.length) * chars.length;
  while (result.length < CODE_LENGTH) {
    const buf = randomBytes(CODE_LENGTH - result.length);
    for (const b of buf) {
      if (b >= acceptThreshold) continue;
      result.push(chars[b % chars.length]);
      if (result.length >= CODE_LENGTH) break;
    }
  }
  return result.join('');
}

export function generateAccountId(): string {
  return generateCode(ACCOUNT_ID_CHARS);
}

export function generateInviteCode(): string {
  return generateCode(INVITE_CODE_CHARS);
}
