import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMigration } from '../scripts/prepare-chat-message-deleted-at-migration.mjs';

const expectedIndex = {
  indisvalid: true,
  definition:
    'CREATE INDEX "ChatMessage_conversationID_deletedAt_idx" ON public."ChatMessage" USING btree ("conversationID", "deletedAt")',
};

function fakeClient({ migrationApplied = false, chatTable = true, remaining = false } = {}) {
  const calls = [];
  let batchCalls = 0;
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes('pg_advisory_lock') || text.includes('pg_advisory_unlock')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('to_regclass')) {
        const relation = params[0] === '"ChatMessage"' ? chatTable : true;
        return { rows: [{ relation: relation ? params[0] : null }], rowCount: 1 };
      }
      if (text.includes('FROM "_prisma_migrations"')) {
        return { rows: migrationApplied ? [{ '?column?': 1 }] : [], rowCount: migrationApplied ? 1 : 0 };
      }
      if (text.includes('ADD COLUMN IF NOT EXISTS')) return { rows: [], rowCount: 0 };
      if (text.includes('WITH batch AS')) {
        batchCalls += 1;
        return { rows: batchCalls === 1 ? [{ id: 'm1' }, { id: 'm2' }] : [], rowCount: batchCalls === 1 ? 2 : 0 };
      }
      if (text.includes('FROM pg_class')) {
        const created = calls.some((call) => call.text.includes('CREATE INDEX CONCURRENTLY'));
        return { rows: created ? [expectedIndex] : [], rowCount: created ? 1 : 0 };
      }
      if (text.includes('CREATE INDEX CONCURRENTLY')) return { rows: [], rowCount: 0 };
      if (text.includes('information_schema.columns')) {
        return { rows: [{ data_type: 'timestamp without time zone' }], rowCount: 1 };
      }
      if (text.includes('deletedAt" IS NULL')) {
        return { rows: remaining ? [{ '?column?': 1 }] : [], rowCount: remaining ? 1 : 0 };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
  };
  return { client, calls };
}

test('already-applied databases are a no-op', async () => {
  const { client, calls } = fakeClient({ migrationApplied: true });
  const resolved = [];
  const result = await prepareMigration(client, () => resolved.push('resolve'));

  assert.deepEqual(result, { prepared: false, reason: 'already-applied' });
  assert.deepEqual(resolved, []);
  assert.equal(calls.some((call) => call.text.includes('ALTER TABLE')), false);
});

test('fresh databases let Prisma apply the released migration normally', async () => {
  const { client } = fakeClient({ chatTable: false });
  const result = await prepareMigration(client, () => {
    throw new Error('must not resolve');
  });
  assert.deepEqual(result, { prepared: false, reason: 'fresh-database' });
});

test('existing pending databases prepare, verify, then resolve under the lock', async () => {
  const { client, calls } = fakeClient();
  let resolvedAfterVerification = false;
  const result = await prepareMigration(client, () => {
    resolvedAfterVerification = calls.some((call) =>
      call.text.includes('information_schema.columns'),
    );
  });

  assert.deepEqual(result, { prepared: true, updated: 2 });
  assert.equal(resolvedAfterVerification, true);
  assert.ok(calls.some((call) => call.text.includes('FOR UPDATE SKIP LOCKED')));
  assert.ok(calls.some((call) => call.text.includes('CREATE INDEX CONCURRENTLY')));
  assert.match(calls.at(-1).text, /pg_advisory_unlock/);
});

test('failed verification never marks the migration applied', async () => {
  const { client } = fakeClient({ remaining: true });
  let resolved = false;
  await assert.rejects(
    prepareMigration(client, () => {
      resolved = true;
    }),
    /backfill is incomplete/,
  );
  assert.equal(resolved, false);
});
