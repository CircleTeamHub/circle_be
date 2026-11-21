import { randomBytes } from 'crypto';
import type { CookieOptions, Request, Response } from 'express';
import { hashDeviceId } from './device-trust.service';

/**
 * 网页端会话：refresh token 与设备 ID 放进本服务签发的 HttpOnly cookie，页面刷新
 * 不再掉登录，也不会每次刷新都被当成陌生设备；脚本照样读不到这两样（防 XSS 偷走
 * 长期凭证）。
 *
 * 只有带 `X-Web-Session: 1` 的请求才读写这些 cookie，其余请求（原生 App）一切照旧。
 * 这个自定义头同时是 CSRF 防线：跨域页面要发它必须先过预检，而预检只放行
 * ALLOWED_ORIGINS 里的来源。
 */
export const REFRESH_COOKIE = 'circle_rt';
const DEVICE_COOKIE = 'circle_did';
// setup.ts 的全局前缀 'api/v1'。
const API_PATH = '/api/v1';
const REFRESH_COOKIE_PATH = `${API_PATH}/auth`;
// 浏览器把 cookie 有效期封顶在 400 天。
const DEVICE_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

export function isWebSession(req: Request): boolean {
  return req.headers['x-web-session'] === '1';
}

export function readCookie(req: Request, name: string): string | null {
  for (const pair of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = pair.split('=');
    if (key.trim() === name) return value.join('=').trim();
  }
  return null;
}

/** 设置与清除必须用同一组属性，否则浏览器当成另一枚 cookie，清不掉。 */
function cookieOptions(path: string): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    // 本地开发走 http://localhost，带 Secure 浏览器就不存。
    secure: process.env.NODE_ENV === 'production',
    path,
  };
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions(REFRESH_COOKIE_PATH));
}

/**
 * 网页端设备 ID 的哈希（与原生的 X-Device-Id 同算法）。cookie 缺失或不合规时，
 * 给了 res 的路由当场发一个新 ID 并按它处理这次请求；只读路由不发。
 */
export function webDeviceKey(req: Request, res?: Response): string | null {
  const current = hashDeviceId(readCookie(req, DEVICE_COOKIE));
  if (current || !res) return current;
  const deviceId = randomBytes(32).toString('base64url');
  res.cookie(DEVICE_COOKIE, deviceId, {
    ...cookieOptions(API_PATH),
    maxAge: DEVICE_COOKIE_MAX_AGE_MS,
  });
  return hashDeviceId(deviceId);
}

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

function hasTokens(result: object): result is IssuedTokens {
  return 'refreshToken' in result;
}

/**
 * 发了 token 的结果：refresh token 只进 cookie，响应体只留 access token。
 * 没发 token 的结果（如陌生设备验证单）原样返回。
 */
export function moveRefreshTokenToCookie<T extends object>(
  res: Response,
  result: T,
  maxAgeMs: number,
): T | { accessToken: string } {
  if (!hasTokens(result)) return result;
  res.cookie(REFRESH_COOKIE, result.refreshToken, {
    ...cookieOptions(REFRESH_COOKIE_PATH),
    maxAge: maxAgeMs,
  });
  return { accessToken: result.accessToken };
}
