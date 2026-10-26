import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prisma } from 'src/generated/prisma';
import type { PrismaService } from 'src/prisma/prisma.service';
import { CHAT_MEDIA_KEY_FIELDS } from 'src/chat/chat.constants';
import { StorageAuditService } from 'src/upload/storage-audit.service';
import {
  chatBurnArchiveIrregularRowsQuery,
  chatMediaIrregularRowsQuery,
  chatMediaKeyReferencesQuery,
  noteCardSectionsPageQuery,
} from 'src/upload/storage-audit.query';
import {
  describePostgres,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';
import { capturePrisma, captureQueries } from './prisma-sql-capture';

/**
 * 存量对象盘点的聊天媒体引用从「全表读进内存 Set」反转成「按 S3 列举批次反查」后，
 * 在真 PostgreSQL 上与原实现对照：
 * - 原实现照抄改造前的代码：ChatMessage / ChatBurnArchive 按 id 游标读所有媒体类型行、
 *   Note 整列 sections，SQL 用 prisma-sql-capture 从原来的 Prisma 调用现场编译；
 * - 覆盖活消息的 key / thumbKey、voice 带 thumbKey（不算）、text 带 key（不算）、带 key
 *   的墓碑、清空了的墓碑、焚毁归档、URL / 前导 / / 早期前缀等不规整的值、数字 key、
 *   笔记分区名片（含坏数据）、宽限期、跨 1000 条的列举分页与引用分页；
 * - 两边判定的孤儿集合逐个 key 相同，audit() 的计数相同；
 * - EXPLAIN：反查走 20261019000300 的四条表达式索引（20261026000910 的表达式统计让
 *   一批 1000 个 key 不被估成整表），不规整的行走 20261026000900 的部分索引；原实现
 *   要把整张 ChatMessage 的媒体行读一遍。
 */
const MIGRATIONS: Array<[string, number]> = [
  ['20261019000300_burn_media_reference_indexes', 4],
  ['20261026000900_storage_audit_irregular_chat_media_indexes', 2],
  ['20261026000910_chat_media_key_expression_statistics', 4],
];

describePostgres('storage audit chat reverse lookup (PostgreSQL)', () => {
  let s: IsolatedSchema;
  const capture = capturePrisma();
  const objects: Array<{ key: string; size: number; lastModified: Date }> = [];
  const old = new Date('2026-01-01T00:00:00.000Z');
  const now = new Date('2026-10-26T00:00:00.000Z');
  const userAvatars = ['https://api.test/circle/avatars/u-avatar.jpg'];

  const run = async <T>(sql: string, values: unknown[]): Promise<T[]> =>
    (await s.db.query(sql, values)).rows as T[];

  /** 只改动了三处来源；其余十几张表这里给空（或固定几行），两边一样。 */
  const unchangedModels = () => {
    const empty = { findMany: () => Promise.resolve([]) };
    return {
      user: {
        findMany: (args: { cursor?: unknown }) =>
          Promise.resolve(
            args.cursor
              ? []
              : userAvatars.map((avatarUrl, i) => ({
                  id: `user-${i}`,
                  avatarUrl,
                  avatarFrame: null,
                  cover: null,
                })),
          ),
      },
      avatarFrameAsset: empty,
      iconAsset: empty,
      adminAdvertisement: empty,
      friend: empty,
      circle: empty,
      chatConversation: empty,
      noteMedia: empty,
      noteDraft: empty,
      trace: empty,
      traceComment: empty,
      circlePost: empty,
      supportRechargePaymentCode: empty,
      consoleRelease: empty,
    };
  };

  const upload = {
    objectKeyFromPublicUrl: (url: string | null | undefined) =>
      url?.startsWith('https://api.test/circle/')
        ? url.slice('https://api.test/circle/'.length).split('?')[0]
        : null,
    listObjects: (prefix: string, token?: string) => {
      const all = objects
        .filter((object) => object.key.startsWith(prefix))
        .sort((a, b) => (a.key < b.key ? -1 : 1));
      const start = token ? Number(token) : 0;
      const page = all.slice(start, start + 1000);
      return Promise.resolve({
        objects: page,
        nextContinuationToken:
          start + 1000 < all.length ? String(start + 1000) : undefined,
      });
    },
  };

  /** 新实现：$queryRaw 落到隔离 schema。 */
  const newService = () =>
    new StorageAuditService(
      {
        ...unchangedModels(),
        $queryRaw: (query: Prisma.Sql) => run(query.text, query.values),
      } as unknown as PrismaService,
      upload as never,
    );

  /** 原 Prisma 调用现场编译成 SQL 再到隔离 schema 执行。 */
  const oldFindMany =
    (model: 'chatMessage' | 'chatBurnArchive' | 'note') =>
    async (args: Record<string, unknown>) => {
      const [query] = await captureQueries(capture.queries, () =>
        (
          capture.prisma[model] as unknown as {
            findMany: (args: unknown) => Promise<unknown>;
          }
        ).findMany(args),
      );
      return run(query.sql, query.args);
    };

  /** 原实现：改造前的三处来源照抄，跑原来的 Prisma 调用。 */
  const oldService = () =>
    new StorageAuditService(
      {
        ...unchangedModels(),
        chatMessage: { findMany: oldFindMany('chatMessage') },
        chatBurnArchive: { findMany: oldFindMany('chatBurnArchive') },
        note: { findMany: oldFindMany('note') },
      } as unknown as PrismaService,
      upload as never,
    );

  type Internals = {
    collectReferencedKeys: () => Promise<Set<string>>;
    findReferencedChatKeys: (keys: string[]) => Promise<Set<string>>;
    collectFrom: <T extends { id: string }>(
      fetchPage: (cursor: string | undefined, take: number) => Promise<T[]>,
      extract: (row: T) => void,
    ) => Promise<void>;
    toObjectKey: (value: string) => string | null;
  };

  /** 改造前 collectReferencedKeys 里三处来源的读法与提取规则（逐字照抄）。 */
  const oldReferencedKeys = async () => {
    const service = oldService() as unknown as Internals;
    const keys = new Set<string>();
    const add = (value: unknown) => {
      if (typeof value !== 'string' || value.length === 0) return;
      const key = service.toObjectKey(value);
      if (key) keys.add(key);
    };
    for (const avatarUrl of userAvatars) add(avatarUrl);
    const addCardAvatars = (sections: unknown) => {
      if (!sections || typeof sections !== 'object' || Array.isArray(sections))
        return;
      for (const name of ['contacts', 'groups']) {
        const section = (sections as Record<string, unknown>)[name];
        if (!section || typeof section !== 'object' || Array.isArray(section))
          continue;
        const items = (section as Record<string, unknown>).items;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          if (!item || typeof item !== 'object' || Array.isArray(item))
            continue;
          add(item.faceURL);
          add(item.avatarUrl);
        }
      }
    };
    const pageArgs =
      (select: Record<string, true>, where?: unknown) =>
      (cursor: string | undefined, take: number) => ({
        ...(where ? { where } : {}),
        select,
        orderBy: { id: 'asc' },
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
    const notePage = pageArgs({ id: true, sections: true });
    await service.collectFrom(
      async (cursor, take) =>
        (await oldFindMany('note')(notePage(cursor, take))) as Array<{
          id: string;
          sections: unknown;
        }>,
      (row) => addCardAvatars(row.sections),
    );
    const extractChat = (row: {
      id: string;
      type: string;
      content: unknown;
    }) => {
      const fields = CHAT_MEDIA_KEY_FIELDS[row.type];
      if (!fields) return;
      const content = row.content;
      if (typeof content !== 'object' || content === null) return;
      for (const field of fields) {
        add((content as Record<string, unknown>)[field.key]);
      }
    };
    for (const model of ['chatMessage', 'chatBurnArchive'] as const) {
      const chatPage = pageArgs(
        { id: true, type: true, content: true },
        { type: { in: Object.keys(CHAT_MEDIA_KEY_FIELDS) } },
      );
      await service.collectFrom(
        async (cursor, take) =>
          (await oldFindMany(model)(chatPage(cursor, take))) as Array<{
            id: string;
            type: string;
            content: unknown;
          }>,
        extractChat,
      );
    }
    return keys;
  };

  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const isFresh = (object: { lastModified: Date }) =>
    object.lastModified > cutoff;

  const oldOrphans = async () => {
    const referenced = await oldReferencedKeys();
    return objects
      .filter((object) => !isFresh(object) && !referenced.has(object.key))
      .map((object) => object.key)
      .sort();
  };

  const newOrphans = async () => {
    const service = newService() as unknown as Internals;
    const referenced = await service.collectReferencedKeys();
    const orphans: string[] = [];
    for (const prefix of [
      'avatars/',
      'covers/',
      'posts/',
      'notes/',
      'friends/',
      'chat/',
    ]) {
      let token: string | undefined;
      do {
        const page = await upload.listObjects(prefix, token);
        token = page.nextContinuationToken;
        const pending = page.objects.filter(
          (object) => !isFresh(object) && !referenced.has(object.key),
        );
        const chat = await service.findReferencedChatKeys(
          pending.map((object) => object.key),
        );
        for (const object of pending) {
          if (!chat.has(object.key)) orphans.push(object.key);
        }
      } while (token);
    }
    return { orphans: orphans.sort(), referencedSize: referenced.size };
  };

  const object = (key: string, lastModified = old, size = key.length) =>
    objects.push({ key, size, lastModified });

  beforeAll(async () => {
    s = await openIsolatedSchema('storage_audit');
    await s.db.query(`
      CREATE TABLE "ChatMessage" (
        id text PRIMARY KEY,
        type text NOT NULL,
        content jsonb NOT NULL,
        deleted boolean NOT NULL DEFAULT false
      );
      CREATE TABLE "ChatBurnArchive" (
        id text PRIMARY KEY,
        type text NOT NULL,
        content jsonb NOT NULL
      );
      CREATE TABLE "Note" (id text PRIMARY KEY, sections jsonb);
    `);
    for (const [name, count] of MIGRATIONS) {
      const statements = readFileSync(
        join(process.cwd(), 'prisma/migrations', name, 'migration.sql'),
        'utf8',
      )
        .replace(/--.*$/gm, '')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
      expect(statements).toHaveLength(count);
      for (const statement of statements) await s.db.query(statement);
    }

    const message = (
      id: string,
      type: string,
      content: unknown,
      deleted = false,
    ) =>
      s.db.query(
        `INSERT INTO "ChatMessage" (id, type, content, deleted) VALUES ($1, $2, $3::jsonb, $4)`,
        [id, type, JSON.stringify(content), deleted],
      );
    const archive = (id: string, type: string, content: unknown) =>
      s.db.query(
        `INSERT INTO "ChatBurnArchive" (id, type, content) VALUES ($1, $2, $3::jsonb)`,
        [id, type, JSON.stringify(content)],
      );

    await message('m-live', 'image', {
      key: 'chat/u1/live.jpg',
      thumbKey: 'chat/u1/live_thumb.jpg',
    });
    await message('m-video', 'video', { key: 'chat/u1/video.mp4' });
    // voice 的字段表里没有 thumbKey；text 没有媒体字段。
    await message('m-voice', 'voice', {
      key: 'chat/u1/voice.m4a',
      thumbKey: 'chat/u1/voice_thumb.jpg',
    });
    await message('m-text', 'text', { key: 'chat/u1/text.jpg' });
    // 带 key 的墓碑（原实现不看 deleted）与正常清空的墓碑。
    await message('m-tomb', 'image', { key: 'chat/u1/tomb.jpg' }, true);
    await message('m-tomb-cleared', 'image', {}, true);
    // 不规整的值：本站 URL、前导 /、COS 虚拟主机 URL、早期别的前缀、数字、空串。
    await message('m-url', 'file', {
      key: 'https://api.test/circle/chat/u1/url_form.jpg',
    });
    await message('m-slash', 'image', {
      key: 'chat/u1/plain.jpg',
      thumbKey: '/chat/u1/slash_thumb.jpg',
    });
    await message('m-cos', 'video', {
      key: 'https://bucket.cos.test/chat/u1/cos.mp4',
    });
    await message('m-legacy', 'image', { key: 'notes/u1/legacy-chat.jpg' });
    await message('m-number', 'image', { key: 123 });
    await message('m-empty', 'file', { key: '' });
    await message('m-array', 'image', ['chat/u1/array.jpg']);
    await archive('a-video', 'video', {
      key: 'chat/u1/archived.mp4',
      thumbKey: 'chat/u1/archived_thumb.jpg',
    });
    await archive('a-file', 'file', {
      key: 'chat/u1/archived.pdf',
      thumbKey: 'chat/u1/archive_file_thumb.jpg',
    });
    await archive('a-url', 'image', {
      key: 'https://api.test/circle/chat/u2/archived_url.jpg',
    });
    // 批量：3000 个 chat/ 对象，每三个有一条活消息引用；1200 个带 key 的墓碑
    // （不规整的行要翻两页）；1100 条笔记的分区名片（笔记要翻两页）。
    await s.db.query(`
      INSERT INTO "ChatMessage" (id, type, content)
      SELECT 'bulk-' || lpad(g::text, 5, '0'), 'image',
             jsonb_build_object('key', 'chat/bulk/' || lpad(g::text, 5, '0') || '.jpg')
      FROM generate_series(1, 3000) g WHERE g % 3 = 0;
      INSERT INTO "ChatMessage" (id, type, content, deleted)
      SELECT 'tomb-' || lpad(g::text, 5, '0'), 'voice',
             jsonb_build_object('key', 'chat/tomb/' || lpad(g::text, 5, '0') || '.m4a'), true
      FROM generate_series(1, 1200) g;
      INSERT INTO "Note" (id, sections)
      SELECT 'note-' || lpad(g::text, 5, '0'),
             jsonb_build_object('contacts', jsonb_build_object('items', jsonb_build_array(
               jsonb_build_object('faceURL', 'https://api.test/circle/avatars/bulk-' || g || '.jpg'))))
      FROM generate_series(1, 1100) g;
    `);
    await s.db.query(
      `INSERT INTO "Note" (id, sections) VALUES ($1, $2::jsonb), ($3, $4::jsonb), ($5, $6::jsonb), ($7, NULL)`,
      [
        'n-cards',
        JSON.stringify({
          text: { content: 'https://api.test/circle/avatars/card-in-text.jpg' },
          contacts: {
            items: [
              { faceURL: 'https://api.test/circle/avatars/card-old.jpg?x=1' },
              null,
              ['https://api.test/circle/avatars/card-in-array.jpg'],
            ],
          },
          groups: {
            items: [
              { avatarUrl: 'https://api.test/circle/avatars/card-group.jpg' },
            ],
          },
        }),
        'n-bad',
        JSON.stringify({
          contacts: [
            { faceURL: 'https://api.test/circle/avatars/card-bad.jpg' },
          ],
        }),
        'n-array',
        JSON.stringify([
          { contacts: { items: [{ faceURL: 'avatars/card-arr.jpg' }] } },
        ]),
        'n-null',
      ],
    );

    for (const key of [
      'chat/u1/live.jpg',
      'chat/u1/live_thumb.jpg',
      'chat/u1/video.mp4',
      'chat/u1/voice.m4a',
      'chat/u1/voice_thumb.jpg',
      'chat/u1/text.jpg',
      'chat/u1/tomb.jpg',
      'chat/u1/tomb_cleared.jpg',
      'chat/u1/url_form.jpg',
      'chat/u1/plain.jpg',
      'chat/u1/slash_thumb.jpg',
      'chat/u1/cos.mp4',
      'chat/u1/array.jpg',
      'chat/u1/archived.mp4',
      'chat/u1/archived_thumb.jpg',
      'chat/u1/archived.pdf',
      'chat/u1/archive_file_thumb.jpg',
      'chat/u2/archived_url.jpg',
      'chat/u1/orphan.jpg',
      'notes/u1/legacy-chat.jpg',
      'notes/u1/orphan.jpg',
      'avatars/u-avatar.jpg',
      'avatars/card-old.jpg',
      'avatars/card-group.jpg',
      'avatars/card-in-text.jpg',
      'avatars/card-in-array.jpg',
      'avatars/card-bad.jpg',
      'avatars/card-arr.jpg',
      'avatars/orphan.jpg',
    ]) {
      object(key);
    }
    object('chat/u1/fresh.jpg', new Date(now.getTime() - 60_000));
    for (let g = 1; g <= 3000; g += 1) {
      object(`chat/bulk/${String(g).padStart(5, '0')}.jpg`);
    }
    for (let g = 1; g <= 1200; g += 2) {
      object(`chat/tomb/${String(g).padStart(5, '0')}.m4a`);
    }
    for (let g = 1; g <= 1100; g += 3) object(`avatars/bulk-${g}.jpg`);
    object('avatars/bulk-99999.jpg');
  });

  afterAll(async () => {
    await s?.close();
  });

  it('judges exactly the same orphans as the full in-memory inventory', async () => {
    const expected = await oldOrphans();
    const actual = await newOrphans();

    expect(actual.orphans).toEqual(expected);
    // 不只是两边都空：逐类核对原规则下的结论。
    expect(expected).toEqual(
      expect.arrayContaining([
        'chat/u1/voice_thumb.jpg',
        'chat/u1/text.jpg',
        'chat/u1/tomb_cleared.jpg',
        'chat/u1/array.jpg',
        'chat/u1/archive_file_thumb.jpg',
        'chat/u1/orphan.jpg',
        'notes/u1/orphan.jpg',
        'avatars/card-in-text.jpg',
        'avatars/card-in-array.jpg',
        'avatars/card-bad.jpg',
        'avatars/card-arr.jpg',
        'avatars/orphan.jpg',
        'avatars/bulk-99999.jpg',
      ]),
    );
    for (const kept of [
      'chat/u1/live.jpg',
      'chat/u1/live_thumb.jpg',
      'chat/u1/tomb.jpg',
      'chat/u1/url_form.jpg',
      'chat/u1/slash_thumb.jpg',
      'chat/u1/cos.mp4',
      'chat/u1/archived_thumb.jpg',
      'chat/u2/archived_url.jpg',
      'notes/u1/legacy-chat.jpg',
      'avatars/card-old.jpg',
      'avatars/card-group.jpg',
      'chat/tomb/00001.m4a',
      'avatars/bulk-1099.jpg',
    ]) {
      expect(expected).not.toContain(kept);
    }
    // 2000 个没被引用的 bulk 对象跨了三页列举。
    expect(expected.filter((key) => key.startsWith('chat/bulk/'))).toHaveLength(
      2000,
    );
    // 内存里的 Set 不再装活消息的规整引用（1000 条 bulk、live 等）：只剩不规整的行、
    // 笔记名片与其它来源。
    const oldSize = (await oldReferencedKeys()).size;
    expect(actual.referencedSize).toBeLessThan(oldSize - 900);
  });

  it('reports the counts the full in-memory inventory implies from audit()', async () => {
    const orphans = new Set(await oldOrphans());
    const expected = {
      scanned: objects.length,
      orphanCount: orphans.size,
      orphanBytes: objects
        .filter((object) => orphans.has(object.key))
        .reduce((sum, object) => sum + object.size, 0),
    };
    expect(await newService().audit(now)).toEqual(expected);
  });

  it('looks references up through the expression indexes instead of reading every media row', async () => {
    await s.db.query(`
      INSERT INTO "ChatMessage" (id, type, content)
      SELECT 'big-' || g, CASE WHEN g % 4 = 0 THEN 'image' ELSE 'text' END,
             CASE WHEN g % 4 = 0
                  THEN jsonb_build_object('key', 'chat/big/' || g || '.jpg', 'thumbKey', 'chat/big/' || g || '_t.jpg')
                  ELSE jsonb_build_object('text', repeat('hello ', 20)) END
      FROM generate_series(1, 60000) g;
      INSERT INTO "ChatBurnArchive" (id, type, content)
      SELECT 'arch-' || g, CASE WHEN g % 2 = 0 THEN 'image' ELSE 'text' END,
             jsonb_build_object('key', 'chat/arch/' || g || '.jpg', 'text', repeat('hello ', 20))
      FROM generate_series(1, 40000) g;
      ANALYZE "ChatMessage"; ANALYZE "ChatBurnArchive";
    `);
    type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
    const analyze = async (query: { text: string; values: unknown[] }) => {
      const result = await s.db.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${query.text}`,
        query.values,
      );
      return result.rows[0]['QUERY PLAN'][0].Plan;
    };
    const nodes = (plan: PlanNode): PlanNode[] => [
      plan,
      ...(plan.Plans ?? []).flatMap(nodes),
    ];
    const rowsRead = (plan: PlanNode, relation: string) =>
      nodes(plan)
        .filter((node) => node['Relation Name'] === relation)
        .reduce(
          (sum, node) =>
            sum +
            (Number(node['Actual Rows'] ?? 0) +
              Number(node['Rows Removed by Filter'] ?? 0)) *
              Number(node['Actual Loops'] ?? 1),
          0,
        );

    // 一页 S3 列举（1000 个 key）的反查。
    const keys = Array.from(
      { length: 1000 },
      (_, i) => `chat/big/${i * 7 + 1}.jpg`,
    );
    const lookup = await analyze(chatMediaKeyReferencesQuery(keys));
    const indexNames = nodes(lookup)
      .map((node) => node['Index Name'])
      .filter(Boolean);
    expect(new Set(indexNames)).toEqual(
      new Set([
        'ChatMessage_media_key_idx',
        'ChatMessage_media_thumbKey_idx',
        'ChatBurnArchive_media_key_idx',
        'ChatBurnArchive_media_thumbKey_idx',
      ]),
    );
    expect(nodes(lookup).some((node) => node['Node Type'] === 'Seq Scan')).toBe(
      false,
    );
    expect(rowsRead(lookup, 'ChatMessage')).toBeLessThan(1000);

    // 不规整的行：走部分索引，读到的就是要的那些行（含翻页游标）。
    for (const [query, index] of [
      [
        chatMediaIrregularRowsQuery(undefined, 1000),
        'ChatMessage_audit_irregular_media_idx',
      ],
      [
        chatMediaIrregularRowsQuery('tomb-00500', 1000),
        'ChatMessage_audit_irregular_media_idx',
      ],
      [
        chatBurnArchiveIrregularRowsQuery(undefined, 1000),
        'ChatBurnArchive_audit_irregular_media_idx',
      ],
    ] as const) {
      const plan = await analyze(query);
      expect(JSON.stringify(plan)).toContain(`"Index Name":"${index}"`);
    }
    // 笔记只带回两个名片数组，不再搬整列 sections。
    const notePage = noteCardSectionsPageQuery(undefined, 5);
    const { rows: noteRows, fields } = await s.db.query(
      notePage.text,
      notePage.values,
    );
    expect(fields.map((field) => field.name)).toEqual([
      'id',
      'contactItems',
      'groupItems',
    ]);
    expect(noteRows).toHaveLength(5);
    const irregular = await analyze(
      chatMediaIrregularRowsQuery(undefined, 1000),
    );
    expect(rowsRead(irregular, 'ChatMessage')).toBeLessThanOrEqual(1000);

    // 原实现：每一批 1000 行都按主键顺序扫，type 只能当过滤；整张表的媒体行都要读到。
    const [oldFirstPage] = await captureQueries(capture.queries, () =>
      capture.prisma.chatMessage.findMany({
        where: { type: { in: Object.keys(CHAT_MEDIA_KEY_FIELDS) } },
        select: { id: true, type: true, content: true },
        orderBy: { id: 'asc' },
        take: 1000,
      }),
    );
    const oldPlan = await analyze({
      text: oldFirstPage.sql,
      values: oldFirstPage.args,
    });
    expect(
      nodes(oldPlan).some(
        (node) =>
          node['Relation Name'] === 'ChatMessage' &&
          String(node['Index Name'] ?? '').includes('audit_irregular'),
      ),
    ).toBe(false);
  }, 180_000);
});
