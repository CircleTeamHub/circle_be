import { createHash } from 'crypto';
import type { Request } from 'express';
import { refreshRateLimitKey } from './web-session';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function req(ip: string, headers: Record<string, string> = {}): Request {
  return { ip, headers } as unknown as Request;
}

describe('refreshRateLimitKey', () => {
  it('counts web refreshes per refresh token, so users behind one IP do not share a budget', () => {
    const alice = req('203.0.113.7', {
      'x-web-session': '1',
      cookie: 'circle_did=dev; circle_rt=alice-token',
    });
    const bob = req('203.0.113.7', {
      'x-web-session': '1',
      cookie: 'circle_rt=bob-token',
    });

    expect(refreshRateLimitKey(alice)).toBe(`rt:${sha256('alice-token')}`);
    expect(refreshRateLimitKey(bob)).toBe(`rt:${sha256('bob-token')}`);
  });

  it('never puts the raw refresh token into the limiter key', () => {
    const key = refreshRateLimitKey(
      req('203.0.113.7', { 'x-web-session': '1', cookie: 'circle_rt=secret' }),
    );
    expect(key).not.toContain('secret');
  });

  it('keeps counting native and cookie-less requests per IP', () => {
    expect(refreshRateLimitKey(req('203.0.113.7'))).toBe('203.0.113.7');
    // Without the header the cookie is ignored, exactly like the controller.
    expect(
      refreshRateLimitKey(req('203.0.113.7', { cookie: 'circle_rt=token' })),
    ).toBe('203.0.113.7');
    expect(
      refreshRateLimitKey(req('203.0.113.7', { 'x-web-session': '1' })),
    ).toBe('203.0.113.7');
  });
});
