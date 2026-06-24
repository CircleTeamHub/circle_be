import { generateAccountId } from './account-id';

describe('generateAccountId', () => {
  it('emits a 6-char lowercase base36 account id without a prefix', () => {
    const id = generateAccountId();
    expect(id).toMatch(/^[a-z0-9]{6}$/);
  });

  it('uses the full alphabet across a large sample (no character lost to a bug)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      for (const ch of generateAccountId()) {
        seen.add(ch);
      }
      if (seen.size === 36) break;
    }
    expect(seen.size).toBe(36);
  });
});
