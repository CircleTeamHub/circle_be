import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { NOTE_CONTENT_JSON_REPAIR_STATEMENTS } from '../src/note/note-content-json-repair';

function allowlistedTestDatabaseUrl(): string | null {
  const databaseUrl =
    process.env.NOTE_CONTENT_REPAIR_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Note content repair migration requires NODE_ENV=test');
  }

  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !/(^|[_-])test($|[_-])/i.test(databaseName)
  ) {
    throw new Error(
      `Refusing note content repair migration on non-test database: ${databaseName}`,
    );
  }
  return databaseUrl;
}

const databaseUrl = allowlistedTestDatabaseUrl();
const describePostgres = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20261013000000_repair_wiped_note_content_json/migration.sql',
  ),
  'utf8',
);

const block = {
  id: 'b1',
  type: 'paragraph',
  props: {},
  content: [{ type: 'text', text: '你好', styles: {} }],
  children: [],
};

type Row = { id: string; contentJson: unknown; sections: unknown };

describePostgres('note contentJson repair migration', () => {
  const schemaName = `note_content_repair_test_${randomUUID().replace(/-/g, '')}`;
  let client: Client;

  const rows: Row[] = [
    // 被清空的形状：顶层与 sections.text 都要修。
    {
      id: 'wiped',
      contentJson: [[], [], []],
      sections: {
        text: { content: '你好', contentJson: [[], []] },
        groups: { items: [{ id: 'g1', name: 'Group' }] },
      },
    },
    // 正常的块、混合形状、空数组、非数组、null：都不能动，也不能报错。
    {
      id: 'healthy',
      contentJson: [block],
      sections: { text: { content: '你好', contentJson: [block] } },
    },
    {
      id: 'mixed',
      contentJson: [[], block],
      sections: { text: { contentJson: [[1], []] } },
    },
    { id: 'empty', contentJson: [], sections: { text: { contentJson: [] } } },
    {
      id: 'scalar',
      contentJson: 'oops',
      sections: { text: { contentJson: { not: 'an array' } }, media: 3 },
    },
    { id: 'nulls', contentJson: null, sections: null },
  ];

  async function snapshot(table: string): Promise<Map<string, Row>> {
    const result = await client.query<Row>(
      `SELECT "id", "contentJson", "sections" FROM "${table}" ORDER BY "id"`,
    );
    return new Map(result.rows.map((row) => [row.id, row]));
  }

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl! });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}"`);
    for (const table of ['Note', 'NoteDraft']) {
      await client.query(`
        CREATE TABLE "${table}" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "contentJson" JSONB,
          "sections" JSONB
        )
      `);
      for (const row of rows) {
        await client.query(
          `INSERT INTO "${table}" ("id", "contentJson", "sections") VALUES ($1, $2::jsonb, $3::jsonb)`,
          [
            row.id,
            row.contentJson === null ? null : JSON.stringify(row.contentJson),
            row.sections === null ? null : JSON.stringify(row.sections),
          ],
        );
      }
    }
    await client.query(migrationSql);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await client.end();
  });

  it.each(['Note', 'NoteDraft'])(
    '%s: wiped contentJson falls back to plain content; everything else untouched',
    async (table) => {
      const after = await snapshot(table);

      const wiped = after.get('wiped')!;
      expect(wiped.contentJson).toBeNull();
      // 只删 text.contentJson；text.content 与其他段落原样保留。
      expect(wiped.sections).toEqual({
        text: { content: '你好' },
        groups: { items: [{ id: 'g1', name: 'Group' }] },
      });

      for (const row of rows.filter((item) => item.id !== 'wiped')) {
        const stored = after.get(row.id)!;
        expect(stored.contentJson).toEqual(row.contentJson);
        expect(stored.sections).toEqual(row.sections);
      }
    },
  );

  it('is idempotent', async () => {
    const before = await snapshot('Note');
    await client.query(migrationSql);
    expect(await snapshot('Note')).toEqual(before);
  });

  // 迁移跑完到切流之间，旧版本还会写出被清空的形状；新版本的定时任务
  // 用同一组语句把它们收回来，且不碰正常行。
  it('repairs rows wiped by an old writer after the migration with the runtime statements', async () => {
    await client.query(
      `UPDATE "Note" SET "contentJson" = $1::jsonb, "sections" = $2::jsonb WHERE "id" = 'wiped'`,
      [
        JSON.stringify([[], []]),
        JSON.stringify({ text: { content: '你好', contentJson: [[]] } }),
      ],
    );
    const before = await snapshot('Note');
    for (const statement of NOTE_CONTENT_JSON_REPAIR_STATEMENTS) {
      await client.query(statement.sql);
    }
    const after = await snapshot('Note');
    expect(after.get('wiped')).toEqual({
      id: 'wiped',
      contentJson: null,
      sections: { text: { content: '你好' } },
    });
    for (const id of [...before.keys()].filter((id) => id !== 'wiped')) {
      expect(after.get(id)).toEqual(before.get(id));
    }
    for (const statement of NOTE_CONTENT_JSON_REPAIR_STATEMENTS) {
      await client.query(statement.sql);
    }
    expect(await snapshot('Note')).toEqual(after);
  });
});
