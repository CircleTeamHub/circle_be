import { readFileSync } from 'fs';
import { join } from 'path';
import type { Prisma } from 'src/generated/prisma';
import {
  CHAT_MEDIA_KEY_FIELDS,
  CHAT_MEDIA_KEY_PREFIX,
} from 'src/chat/chat.constants';
import { StorageAuditService } from './storage-audit.service';
import {
  REGULAR_CHAT_MEDIA_KEY_PREFIX,
  chatBurnArchiveIrregularRowsQuery,
  chatMediaIrregularRowsQuery,
  chatMediaKeyReferencesQuery,
} from './storage-audit.query';

type ChatRow = {
  id: string;
  type: string;
  content: unknown;
  deleted?: boolean;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const fieldValue = (row: ChatRow, field: string): unknown =>
  isObject(row.content) ? row.content[field] : undefined;
const typesWith = (field: string) =>
  Object.keys(CHAT_MEDIA_KEY_FIELDS).filter((type) =>
    CHAT_MEDIA_KEY_FIELDS[type].some((entry) => entry.key === field),
  );

/**
 * storage-audit.query.ts 四类原生查询在单测里的替身：按 SQL 分流，用夹具行照查询的
 * 口径（部分索引谓词、-> 链）算结果。真实 SQL 与原实现的逐 key 对照在
 * test/postgres/storage-audit-reverse.pg-spec.ts。
 */
function fakeAuditRaw(referenced: Record<string, unknown[]>) {
  const chat = (referenced.chatMessage ?? []) as ChatRow[];
  const archive = (referenced.chatBurnArchive ?? []) as ChatRow[];
  const notes = (referenced.note ?? []) as Array<{
    id: string;
    sections?: unknown;
  }>;
  const media = Object.keys(CHAT_MEDIA_KEY_FIELDS);
  const irregular = (row: ChatRow, tombstones: boolean) => {
    if (!media.includes(row.type) || !isObject(row.content)) return false;
    const values = ['key', 'thumbKey'].map((field) => fieldValue(row, field));
    const text = (value: unknown) =>
      value === undefined || value === null ? null : String(value);
    return (
      (tombstones &&
        row.deleted === true &&
        values.some((value) => text(value) !== null)) ||
      values.some((value) => {
        const t = text(value);
        return t !== null && !t.startsWith(REGULAR_CHAT_MEDIA_KEY_PREFIX);
      })
    );
  };
  return jest.fn(async (query: Prisma.Sql) => {
    const sql = query.sql;
    const firstPage = !/"id" >/.test(sql);
    if (sql.includes('UNION')) {
      const wanted = new Set(query.values.find(Array.isArray) as string[]);
      const hits = new Set<string>();
      for (const [rows, live] of [
        [chat, true],
        [archive, false],
      ] as const) {
        for (const row of rows) {
          if (live && row.deleted) continue;
          for (const field of ['key', 'thumbKey']) {
            const value = fieldValue(row, field);
            if (
              typesWith(field).includes(row.type) &&
              typeof value === 'string' &&
              wanted.has(value)
            ) {
              hits.add(value);
            }
          }
        }
      }
      return [...hits].map((key) => ({ key }));
    }
    if (sql.includes('FROM "ChatMessage"')) {
      return firstPage ? chat.filter((row) => irregular(row, true)) : [];
    }
    if (sql.includes('FROM "ChatBurnArchive"')) {
      return firstPage ? archive.filter((row) => irregular(row, false)) : [];
    }
    if (sql.includes('FROM "Note"')) {
      if (!firstPage) return [];
      const items = (sections: unknown, name: string) => {
        const section = isObject(sections) ? sections[name] : undefined;
        return isObject(section) && Array.isArray(section.items)
          ? section.items
          : null;
      };
      return notes.map((note) => ({
        id: note.id,
        contactItems: items(note.sections, 'contacts'),
        groupItems: items(note.sections, 'groups'),
      }));
    }
    throw new Error('unexpected raw query');
  });
}

describe('StorageAuditService', () => {
  const emptyRows = () => ({ findMany: jest.fn().mockResolvedValue([]) });

  function harness(options: {
    objects?: Record<
      string,
      { key: string; size: number; lastModified: Date | null }[]
    >;
    referenced?: Record<string, unknown[]>;
  }) {
    const prisma = {
      $queryRaw: fakeAuditRaw(options.referenced ?? {}),
      chatConversation: emptyRows(),
      user: emptyRows(),
      avatarFrameAsset: emptyRows(),
      iconAsset: emptyRows(),
      friend: emptyRows(),
      circle: emptyRows(),
      noteMedia: emptyRows(),
      noteDraft: emptyRows(),
      trace: emptyRows(),
      traceComment: emptyRows(),
      circlePost: emptyRows(),
      supportRechargePaymentCode: emptyRows(),
      adminAdvertisement: emptyRows(),
      consoleRelease: emptyRows(),
    };
    // note / chatMessage / chatBurnArchive 走原生 SQL（fakeAuditRaw），其余表照旧 findMany。
    const rawModels = ['note', 'chatMessage', 'chatBurnArchive'];
    for (const [model, rows] of Object.entries(options.referenced ?? {})) {
      if (rawModels.includes(model)) continue;
      (prisma as unknown as Record<string, { findMany: jest.Mock }>)[
        model
      ].findMany = jest.fn().mockResolvedValue(rows);
    }
    const listObjects = jest.fn(async (prefix: string) => ({
      objects: options.objects?.[prefix] ?? [],
    }));
    const objectKeyFromPublicUrl = jest.fn(() => null);
    const service = new StorageAuditService(
      prisma as never,
      {
        listObjects,
        objectKeyFromPublicUrl,
      } as never,
    );
    return { service, listObjects, prisma };
  }

  const old = new Date('2020-01-01T00:00:00.000Z');
  const now = new Date('2020-02-01T00:00:00.000Z');

  it('keeps published and draft card avatar snapshots referenced after avatar rotation', async () => {
    const { service } = harness({
      objects: {
        'avatars/': [
          'old-contact',
          'old-circle',
          'legacy-card',
          'draft-card',
          'unused',
        ].map((name) => ({
          key: `avatars/${name}.jpg`,
          size: 1,
          lastModified: old,
        })),
      },
      referenced: {
        user: [
          {
            id: 'friend',
            avatarUrl: 'https://cdn.test/avatars/new-contact.jpg',
          },
        ],
        circle: [
          {
            id: 'circle',
            avatarUrl: 'https://cdn.test/avatars/new-circle.jpg',
          },
        ],
        note: [
          {
            id: 'note',
            sections: {
              contacts: {
                items: [
                  {
                    faceURL:
                      'https://cdn.test/avatars/old-contact.jpg?expired=1',
                  },
                  null,
                ],
              },
              groups: {
                items: [
                  { faceURL: 'https://cdn.test/avatars/old-circle.jpg' },
                  { avatarUrl: 'https://cdn.test/avatars/legacy-card.jpg' },
                ],
              },
            },
          },
        ],
        noteDraft: [
          {
            id: 'draft',
            mediaKeys: [],
            sections: {
              contacts: {
                items: [{ faceURL: 'https://cdn.test/avatars/draft-card.jpg' }],
              },
            },
          },
        ],
      },
    });
    expect(await service.audit(now)).toEqual({
      scanned: 5,
      orphanCount: 1,
      orphanBytes: 1,
    });
  });

  it('audits chat/ against the keys embedded in ChatMessage.content', async () => {
    // OpenIM 时代这里守的是「绝不扫 chat/」——引用固化在 Mongo,Postgres 一条
    // 都没有。自研栈把媒体收敛成 content 只存 object key(image: key/thumbKey,
    // voice/file: key),引用回到了 Postgres,chat/ 从「绝不能扫」翻转成
    // 「必须扫」:撤回/焚毁的对象删除是尽力而为,删失败靠这份账兜底。
    const { service, listObjects } = harness({
      objects: {
        'chat/': [
          { key: 'chat/u1/kept.jpg', size: 10, lastModified: old },
          { key: 'chat/u1/kept_thumb.jpg', size: 2, lastModified: old },
          { key: 'chat/u1/orphan.jpg', size: 32, lastModified: old },
        ],
      },
      referenced: {
        chatMessage: [
          {
            id: 'm1',
            type: 'image',
            content: {
              key: 'chat/u1/kept.jpg',
              thumbKey: 'chat/u1/kept_thumb.jpg',
            },
          },
        ],
      },
    });
    const result = await service.audit(now);

    const scannedPrefixes = listObjects.mock.calls.map((call) => call[0]);
    expect(scannedPrefixes).toContain('chat/');
    // key 与 thumbKey 都算引用;只有真没人指的对象记孤儿。
    expect(result).toMatchObject({ orphanCount: 1, orphanBytes: 32 });
    // note-exports/ 由 MinIO 生命周期规则回收，仍不归这里管。
    expect(
      scannedPrefixes.some((p: string) => p.startsWith('note-exports')),
    ).toBe(false);
  });

  it('counts a draft-only video poster in its reference inventory', async () => {
    const { service } = harness({
      objects: {
        'notes/': [
          { key: 'notes/u1/poster.jpg', size: 100, lastModified: old },
        ],
      },
      referenced: {
        noteDraft: [
          {
            id: 'draft-1',
            mediaKeys: ['notes/u1/video.mp4', 'notes/u1/poster.jpg'],
          },
        ],
      },
    });
    const result = await service.audit(now);
    expect(result).toMatchObject({ orphanCount: 0 });
  });

  it('keeps configured recharge payment codes out of the orphan list', async () => {
    const { service } = harness({
      objects: {
        'chat/': [
          { key: 'chat/admin-1/payment.png', size: 20, lastModified: old },
        ],
      },
      referenced: {
        supportRechargePaymentCode: [
          {
            id: 'code-1',
            objectKey: 'chat/admin-1/payment.png',
          },
        ],
      },
    });

    expect((await service.audit(now))?.orphanCount).toBe(0);
  });

  it('media types without a field map never leak keys into the reference set', async () => {
    // text/卡片类 content 没有媒体 key;万一有行混进扫描,提取器要按 type
    // 白名单跳过,而不是把 content 里碰巧叫 key 的字符串当引用。
    const { service } = harness({
      objects: {
        'chat/': [{ key: 'chat/u1/orphan.jpg', size: 8, lastModified: old }],
      },
      referenced: {
        chatMessage: [
          { id: 'm2', type: 'text', content: { key: 'chat/u1/orphan.jpg' } },
        ],
      },
    });
    const result = await service.audit(now);
    expect(result).toMatchObject({ orphanCount: 1 });
  });

  it('keeps advertisement images out of the orphan list', async () => {
    const { service } = harness({
      objects: {
        'posts/': [{ key: 'posts/banner.jpg', size: 20, lastModified: old }],
      },
      referenced: {
        adminAdvertisement: [
          {
            id: 'ad-1',
            imageUrl: 'https://api.example.com/circle/posts/banner.jpg',
          },
        ],
      },
    });

    expect((await service.audit(now))?.orphanCount).toBe(0);
  });

  it('reports unreferenced objects without deleting anything', async () => {
    const { service, listObjects } = harness({
      objects: {
        'avatars/': [
          { key: 'avatars/kept.jpg', size: 10, lastModified: old },
          { key: 'avatars/orphan.jpg', size: 32, lastModified: old },
        ],
      },
      referenced: {
        user: [
          {
            avatarUrl: 'https://api.example.com/circle/avatars/kept.jpg',
            avatarFrame: null,
            cover: null,
          },
        ],
      },
    });

    const result = await service.audit(now);

    expect(result).toEqual({ scanned: 2, orphanCount: 1, orphanBytes: 32 });
    // 服务本身没有任何删除能力 —— 只有 listObjects 被调用过。
    expect(Object.keys(listObjects.mock.calls[0])).toBeDefined();
  });

  it('matches references by object key, not by full URL', async () => {
    // 库里存的是完整 URL，而域名随环境变化（dev 是 IP:端口，生产是域名）。
    // 拿 URL 直接比会把所有历史对象判成孤儿。
    const { service } = harness({
      objects: {
        'avatars/': [{ key: 'avatars/a.jpg', size: 1, lastModified: old }],
      },
      referenced: {
        user: [
          {
            avatarUrl: 'http://192.168.1.65:9000/circle/avatars/a.jpg',
            avatarFrame: null,
            cover: null,
          },
        ],
      },
    });

    expect((await service.audit(now))?.orphanCount).toBe(0);
  });

  it('keeps the first path segment for virtual-hosted COS URLs', async () => {
    const { service } = harness({
      objects: {
        'avatars/': [{ key: 'avatars/u1/a.jpg', size: 1, lastModified: old }],
      },
      referenced: {
        user: [
          {
            avatarUrl:
              'https://windnote-123.cos.ap-tokyo.myqcloud.com/avatars/u1/a.jpg',
            avatarFrame: null,
            cover: null,
          },
        ],
      },
    });

    expect((await service.audit(now))?.orphanCount).toBe(0);
  });

  it('spares objects inside the grace period', async () => {
    // 客户端拿到直传地址后才上传、上传完才写库，中间有窗口；刚传上来还没被引用
    // 不等于孤儿。
    const fresh = new Date(now.getTime() - 60 * 1000);
    const { service } = harness({
      objects: {
        'avatars/': [
          { key: 'avatars/fresh.jpg', size: 5, lastModified: fresh },
        ],
      },
    });

    expect((await service.audit(now))?.orphanCount).toBe(0);
  });

  it('covers every URL-bearing column in the schema', () => {
    // 漏掉一处引用来源，那批对象就会被误报成孤儿 —— 真开删除时就是删用户数据。
    // 这条从 schema 里重新筛一遍字段，与服务实际查询的模型对账。
    const schema = readFileSync(
      join(process.cwd(), 'prisma/schema.prisma'),
      'utf8',
    );
    const source = readFileSync(
      join(process.cwd(), 'src/upload/storage-audit.service.ts'),
      'utf8',
    );

    let model: string | null = null;
    const expected = new Set<string>();
    for (const line of schema.split('\n')) {
      const modelMatch = /^model (\w+) \{/.exec(line);
      if (modelMatch) {
        model = modelMatch[1];
        continue;
      }
      if (line.startsWith('}')) {
        model = null;
        continue;
      }
      const field =
        /^\s+(\w*(?:[uU]rl|URL|avatar|cover|image|photo)\w*)\s+(String\??|String\[\])/.exec(
          line,
        );
      if (field && model && !field[1].endsWith('ID')) {
        expected.add(model);
      }
    }

    for (const modelName of expected) {
      const accessor = modelName.charAt(0).toLowerCase() + modelName.slice(1);
      expect(source).toContain(`this.prisma.${accessor}.findMany`);
    }
  });

  it('keeps pending friend-request photos out of the orphan list', async () => {
    // 建好友申请时带的照片在接受之前一直存在 pendingPhotosBySender。
    // 漏掉它:一个挂了超过 24h 宽限期的待处理申请,它那批仍被引用的照片会被
    // 报成孤儿 —— 而这份账正是用来授权后续删除的,误报一条就可能删掉用户的照片。
    const { service } = harness({
      objects: {
        'friends/': [
          { key: 'friends/pending.jpg', size: 10, lastModified: old },
        ],
      },
      referenced: {
        friend: [
          {
            id: 'f1',
            photosA: [],
            photosB: [],
            pendingPhotosBySender: [
              'https://cdn.test/circle/friends/pending.jpg',
            ],
          },
        ],
      },
    });

    const result = await service.audit(now);
    expect(result?.orphanCount).toBe(0);
  });

  it('never writes a raw object key into the logs', async () => {
    // key 里带用户 id;friends/ 这类前缀又是匿名可读的,拿到 key 就能拼出可下载的
    // URL。而这份账**会误报** —— 被列出来的对象未必真没人引用,等于把仍在使用的
    // 用户媒体地址抄进了日志。
    const secretKey = 'friends/u-12345/private-photo.jpg';
    const { service } = harness({
      objects: {
        'friends/': [{ key: secretKey, size: 10, lastModified: old }],
      },
    });
    const logged: string[] = [];
    jest
      .spyOn(
        (service as unknown as { logger: { log: (m: string) => void } }).logger,
        'log',
      )
      .mockImplementation((message: string) => {
        logged.push(String(message));
      });

    const result = await service.audit(now);
    expect(result?.orphanCount).toBe(1);
    const all = logged.join('\n');
    expect(all).not.toContain(secretKey);
    expect(all).not.toContain('u-12345');
    expect(all).not.toContain('private-photo');
    // 前缀级信息仍然保留,足够定位是哪一类对象在堆积。
    expect(all).toContain('friends/');
  });

  it('reads references in bounded sequential batches, not one big findMany', async () => {
    // 九张表并发全量物化会同时吃掉连接池十条里的九条,并把整份结果集留在
    // 1 GiB 的容器里 —— 05:00 那一刻要么把请求饿死,要么 OOM。
    const { service, prisma } = harness({});
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `u-${String(start + i).padStart(5, '0')}`,
        avatarUrl: null,
        avatarFrame: null,
        cover: null,
      }));
    prisma.user.findMany = jest
      .fn()
      .mockResolvedValueOnce(page(0, 1000))
      .mockResolvedValueOnce(page(1000, 1000))
      .mockResolvedValueOnce(page(2000, 7));

    await service.audit(now);

    expect(prisma.user.findMany).toHaveBeenCalledTimes(3);
    const first = prisma.user.findMany.mock.calls[0][0];
    const second = prisma.user.findMany.mock.calls[1][0];
    expect(first.take).toBe(1000);
    expect(first.cursor).toBeUndefined();
    // 第二页起必须带游标,否则会一直重复取第一页。
    expect(second.cursor).toEqual({ id: 'u-00999' });
    expect(second.skip).toBe(1);
  });
  it('does not report 180-day archive attachments as orphaned user media', async () => {
    const { service } = harness({
      objects: {
        'chat/': [{ key: 'chat/u1/retained.jpg', size: 10, lastModified: old }],
      },
      referenced: {
        chatBurnArchive: [
          {
            id: 'burned',
            type: 'image',
            content: { key: 'chat/u1/retained.jpg' },
          },
        ],
      },
    });
    expect(await service.audit(now)).toMatchObject({ orphanCount: 0 });
  });

  // 聊天媒体从「全表读进 Set」反转成「按列举批次反查」：规整引用（值即 key）走表达式
  // 索引，部分索引兜住的墓碑 / 不规整值才读进内存。
  describe('chat media reverse lookup', () => {
    const quoted = (types: string[]) =>
      `IN (${types.map((type) => `'${type}'`).join(', ')})`;

    it('pins the regular prefix and the literal type lists to the chat field table', () => {
      expect(REGULAR_CHAT_MEDIA_KEY_PREFIX).toBe(CHAT_MEDIA_KEY_PREFIX);
      const lookup = chatMediaKeyReferencesQuery(['chat/a']).sql;
      expect(lookup).toContain(quoted(typesWith('key')));
      expect(lookup).toContain(quoted(typesWith('thumbKey')));
      for (const query of [
        chatMediaIrregularRowsQuery(undefined, 1000),
        chatBurnArchiveIrregularRowsQuery(undefined, 1000),
      ]) {
        expect(query.sql).toContain(quoted(Object.keys(CHAT_MEDIA_KEY_FIELDS)));
      }
    });

    it('looks up only the unresolved, out-of-grace chat keys of each listing page', async () => {
      const fresh = new Date(now.getTime() - 60 * 1000);
      const { service, prisma } = harness({
        objects: {
          'chat/': [
            { key: 'chat/admin/code.png', size: 1, lastModified: old },
            { key: 'chat/u1/fresh.jpg', size: 1, lastModified: fresh },
            { key: 'chat/u1/pending.jpg', size: 1, lastModified: old },
          ],
          'avatars/': [{ key: 'avatars/a.jpg', size: 1, lastModified: old }],
        },
        referenced: {
          supportRechargePaymentCode: [
            { id: 'code', objectKey: 'chat/admin/code.png' },
          ],
        },
      });

      expect(await service.audit(now)).toMatchObject({ orphanCount: 2 });

      const lookups = prisma.$queryRaw.mock.calls
        .map(([query]) => query as Prisma.Sql)
        .filter((query) => query.sql.includes('UNION'));
      expect(lookups).toEqual([
        chatMediaKeyReferencesQuery(['chat/u1/pending.jpg']),
      ]);
    });

    it('keeps a tombstone that still carries its key, not one whose content was cleared', async () => {
      const { service } = harness({
        objects: {
          'chat/': [
            { key: 'chat/u1/tomb.jpg', size: 5, lastModified: old },
            { key: 'chat/u1/cleared.jpg', size: 7, lastModified: old },
          ],
        },
        referenced: {
          chatMessage: [
            {
              id: 'm-tomb',
              type: 'image',
              deleted: true,
              content: { key: 'chat/u1/tomb.jpg' },
            },
            { id: 'm-cleared', type: 'image', deleted: true, content: {} },
          ],
        },
      });

      expect(await service.audit(now)).toMatchObject({
        orphanCount: 1,
        orphanBytes: 7,
      });
    });

    it('resolves irregular stored values with the same URL rules as before', async () => {
      const { service } = harness({
        objects: {
          'chat/': [
            { key: 'chat/u1/slash.jpg', size: 1, lastModified: old },
            { key: 'chat/u1/cos.mp4', size: 1, lastModified: old },
          ],
        },
        referenced: {
          chatMessage: [
            { id: 'm1', type: 'image', content: { key: '/chat/u1/slash.jpg' } },
          ],
          chatBurnArchive: [
            {
              id: 'a1',
              type: 'video',
              content: { key: 'https://bucket.cos.test/chat/u1/cos.mp4' },
            },
          ],
        },
      });

      expect(await service.audit(now)).toMatchObject({ orphanCount: 0 });
    });
  });
});
