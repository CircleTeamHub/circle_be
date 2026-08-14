import { generateAccountId, generateInviteCode } from './account-id';

describe('generateAccountId', () => {
  it('emits a 6-digit account ID', () => {
    const id = generateAccountId();
    expect(id).toMatch(/^\d{6}$/);
  });

  it('uses every digit across a large sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      for (const ch of generateAccountId()) {
        seen.add(ch);
      }
      if (seen.size === 10) break;
    }
    expect(seen.size).toBe(10);
  });
});

describe('generateInviteCode', () => {
  it('emits a 6-char uppercase base36 invite code', () => {
    expect(generateInviteCode()).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('uses the full uppercase base36 alphabet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      for (const ch of generateInviteCode()) seen.add(ch);
      if (seen.size === 36) break;
    }
    expect(seen.size).toBe(36);
  });
});
