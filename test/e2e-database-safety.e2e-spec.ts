import { assertSafeE2eDatabase } from './app.factory';

describe('E2E database cleanup safety', () => {
  it.each([
    'postgresql://postgres:postgres@localhost:5432/circle_test?schema=public',
    'postgresql://postgres:postgres@localhost:5432/circle_signup_test?schema=public',
  ])('accepts an explicit test database: %s', (databaseUrl) => {
    expect(() => assertSafeE2eDatabase(databaseUrl, 'test')).not.toThrow();
  });

  it('rejects a non-test runtime', () => {
    expect(() =>
      assertSafeE2eDatabase(
        'postgresql://postgres:postgres@localhost:5432/circle_test',
        'production',
      ),
    ).toThrow('E2E cleanup requires NODE_ENV=test and DATABASE_URL');
  });

  it('rejects a missing database URL', () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => assertSafeE2eDatabase()).toThrow(
        'E2E cleanup requires NODE_ENV=test and DATABASE_URL',
      );
    } finally {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it('rejects a non-test database name', () => {
    expect(() =>
      assertSafeE2eDatabase(
        'postgresql://postgres:postgres@localhost:5432/circle_production',
        'test',
      ),
    ).toThrow('Refusing to clean non-test database: circle_production');
  });
});
