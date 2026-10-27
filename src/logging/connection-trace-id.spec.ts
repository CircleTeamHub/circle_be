import {
  resolveConnectionTraceId,
  safeConnectionTraceId,
} from './connection-trace-id';

const CADDY_ID = 'ws-3f2b8c1e-9d4a-4b7e-8c21-5a6f0e9d1b23';

describe('connection trace IDs', () => {
  it('keeps the ID Caddy put on the upgrade request', () => {
    expect(safeConnectionTraceId(CADDY_ID)).toBe(CADDY_ID);
    expect(resolveConnectionTraceId(CADDY_ID)).toBe(CADDY_ID);
  });

  it.each([
    ['missing', undefined],
    ['empty (Caddy without the matcher)', ''],
    ['free text', 'hello'],
    ['an injected log line', `${CADDY_ID}\n{"event":"forged"}`],
    ['a non-v4 uuid', 'ws-3f2b8c1e-9d4a-1b7e-8c21-5a6f0e9d1b23'],
    ['not a string', 42],
  ])('replaces a %s value with a fresh server-side ID', (_label, value) => {
    expect(safeConnectionTraceId(value)).toBeUndefined();
    const id = resolveConnectionTraceId(value);
    expect(id).toMatch(
      /^ws-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(resolveConnectionTraceId(value)).not.toBe(id);
  });
});
