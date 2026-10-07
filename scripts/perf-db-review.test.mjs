import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAllowed, cleanupReview, percentile } from './perf-db-review.mjs';

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

test('nearest-rank p95 retains a slow outlier even in a short sample', () => {
  assert.equal(percentile([1, 2, 3, 4, 100], 0.95), 100);
  assert.equal(
    percentile(
      Array.from({ length: 100 }, (_, index) => index + 1),
      0.95,
    ),
    95,
  );
  assert.throws(() => percentile([], 0.95));
});

test('cleanup failure always closes the connection and reports the synthetic marker', async () => {
  const failure = new Error('cleanup locked');
  let ended = 0;
  const client = {
    query: async () => {
      throw failure;
    },
    end: async () => {
      ended += 1;
    },
  };
  const errors = [];
  const originalError = console.error;
  console.error = (value) => errors.push(value);
  try {
    await assert.rejects(
      cleanupReview(client, 'perf-db-review:regression:'),
      (error) => error === failure,
    );
    assert.equal(ended, 1);
    assert.match(errors.join('\n'), /perf-db-review:regression:/);
  } finally {
    console.error = originalError;
  }
});
