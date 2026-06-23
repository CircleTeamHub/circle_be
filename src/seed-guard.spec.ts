// scripts/seed-guard.js is a CommonJS helper (no allowJs / type decls), so a
// require() interop import is intentional here.
/* eslint-disable @typescript-eslint/no-require-imports */
const {
  assertDevSeedAllowed,
  isLocalDatabaseUrl,
} = require('../scripts/seed-guard');

describe('seed guard', () => {
  it('allows localhost database URLs for dev seed scripts', () => {
    expect(
      isLocalDatabaseUrl('postgresql://postgres:pw@127.0.0.1:5432/circle'),
    ).toBe(true);
    expect(
      isLocalDatabaseUrl('postgresql://postgres:pw@localhost:5432/circle'),
    ).toBe(true);
  });

  it('rejects non-local database URLs unless explicitly allowed', () => {
    expect(() =>
      assertDevSeedAllowed({
        DATABASE_URL: 'postgresql://postgres:pw@db.example.com:5432/circle',
      }),
    ).toThrow(/Refusing to run dev seed script/);
  });

  it('allows non-local database URLs only with an explicit override', () => {
    expect(() =>
      assertDevSeedAllowed({
        DATABASE_URL: 'postgresql://postgres:pw@db.example.com:5432/circle',
        ALLOW_NON_LOCAL_SEED: 'true',
      }),
    ).not.toThrow();
  });
});
