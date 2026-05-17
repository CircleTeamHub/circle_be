import { generateAccountId } from './account-id';

describe('generateAccountId', () => {
  it('emits the ACC_ prefix and a 6-char base36 suffix', () => {
    const id = generateAccountId();
    expect(id).toMatch(/^ACC_[A-Z0-9]{6}$/);
  });

  it('uses the full alphabet across a large sample (no character lost to a bug)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      for (const ch of generateAccountId().slice(4)) {
        seen.add(ch);
      }
      if (seen.size === 36) break;
    }
    expect(seen.size).toBe(36);
  });
});
