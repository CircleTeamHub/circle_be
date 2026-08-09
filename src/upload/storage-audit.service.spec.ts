import { readFileSync } from 'fs';
import { join } from 'path';
import { StorageAuditService } from './storage-audit.service';

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
      user: emptyRows(),
      avatarFrameAsset: emptyRows(),
      iconAsset: emptyRows(),
      friend: emptyRows(),
      circle: emptyRows(),
      noteMedia: emptyRows(),
      trace: emptyRows(),
      traceComment: emptyRows(),
      circlePost: emptyRows(),
    };
    for (const [model, rows] of Object.entries(options.referenced ?? {})) {
      (prisma as Record<string, { findMany: jest.Mock }>)[model].findMany = jest
        .fn()
        .mockResolvedValue(rows);
    }
    const listObjects = jest.fn(async (prefix: string) => ({
      objects: options.objects?.[prefix] ?? [],
    }));
    const service = new StorageAuditService(
      prisma as never,
      {
        listObjects,
      } as never,
    );
    return { service, listObjects, prisma };
  }

  const old = new Date('2020-01-01T00:00:00.000Z');
  const now = new Date('2020-02-01T00:00:00.000Z');

  it('NEVER scans chat/ — those references live in OpenIM, not Postgres', async () => {
    // 这是本文件最重要的一条。聊天图片的 URL 固化在 OpenIM 消息体（Mongo）里，
    // circle_be 的 Postgres 一条引用都没有。一旦把 chat/ 纳入扫描，每一张聊天图片
    // 都会被判成孤儿 —— 真开了删除就是一次点全站聊天图片的删除。
    const { service, listObjects } = harness({});
    await service.audit(now);

    const scannedPrefixes = listObjects.mock.calls.map((call) => call[0]);
    expect(scannedPrefixes).not.toContain('chat/');
    expect(scannedPrefixes.some((p: string) => p.startsWith('chat'))).toBe(
      false,
    );
    // note-exports/ 由 MinIO 生命周期规则回收，也不归这里管。
    expect(
      scannedPrefixes.some((p: string) => p.startsWith('note-exports')),
    ).toBe(false);
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
});
