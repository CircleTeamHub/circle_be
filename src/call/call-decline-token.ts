import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * 推送来电里「只能拒接这一通」的令牌。
 *
 * 设备锁屏、App 没在跑时，用户在系统来电界面点拒接，原生层拿不到登录态（access
 * token 早过期，刷新逻辑只在 JS 里），只能凭推送里带的这枚令牌调
 * POST /calls/:id/push-decline。令牌绑定 callId + userId + 到期时间：
 * 不能接听、不能读任何数据，过了振铃窗口（另加一点网络余量）即失效。
 *
 * 格式：v1.<userId>.<expSeconds>.<base64url(HMAC-SHA256)>。callId 不进令牌正文，
 * 由路径给出、参与签名 —— 换一通电话的路径验不过。
 */
const VERSION = 'v1';
/** 用户在第 44 秒点拒接、请求在路上走几秒，不该被判过期。 */
export const DECLINE_TOKEN_GRACE_SECONDS = 60;
const USER_ID_PATTERN = /^[0-9a-f-]{8,64}$/i;

export function deriveDeclineTokenKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, 'circle-call-push', 'call-push-decline-v1', 32),
  );
}

function mac(key: Buffer, callId: string, userId: string, exp: number) {
  return createHmac('sha256', key)
    .update(`${VERSION}|${callId}|${userId}|${exp}`)
    .digest();
}

export function issueDeclineToken(
  key: Buffer,
  callId: string,
  userId: string,
  ringExpiresAt: Date,
): string {
  const exp =
    Math.floor(ringExpiresAt.getTime() / 1000) + DECLINE_TOKEN_GRACE_SECONDS;
  return [
    VERSION,
    userId,
    String(exp),
    mac(key, callId, userId, exp).toString('base64url'),
  ].join('.');
}

/** 通过返回 userId；任何不对（格式、过期、签名）都返回 null，不区分原因。 */
export function verifyDeclineToken(
  key: Buffer,
  callId: string,
  token: string,
  now: Date = new Date(),
): string | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, userId, expRaw, signature] = parts;
  if (!USER_ID_PATTERN.test(userId) || !/^\d{1,12}$/.test(expRaw)) return null;
  const exp = Number(expRaw);
  if (exp * 1000 < now.getTime()) return null;
  const expected = mac(key, callId, userId, exp);
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length) return null;
  return timingSafeEqual(actual, expected) ? userId : null;
}
