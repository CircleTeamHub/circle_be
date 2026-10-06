import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAllowed } from './perf-db-review.mjs';

test('only loopback databases are admitted without an explicit override', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.doesNotThrow(() =>
      assertAllowed(
        { PERF_DB_REVIEW: '1' },
        `postgresql://user:pass@${host}/disposable`,
      ),
    );
  }
  for (const host of ['db', 'postgres', 'staging.example.com']) {
    assert.throws(
      () =>
        assertAllowed(
          { PERF_DB_REVIEW: '1' },
          `postgresql://user:pass@${host}/disposable`,
        ),
      /non-local/,
    );
    assert.doesNotThrow(() =>
      assertAllowed(
        { PERF_DB_REVIEW: '1', ALLOW_NON_LOCAL_PERF_DB: '1' },
        `postgresql://user:pass@${host}/disposable`,
      ),
    );
  }
  assert.throws(
    () =>
      assertAllowed(
        {
          PERF_DB_REVIEW: '1',
          ALLOW_NON_LOCAL_PERF_DB: '1',
          NODE_ENV: 'production',
        },
        'postgresql://user:pass@db/disposable',
      ),
    /production/,
  );
});
