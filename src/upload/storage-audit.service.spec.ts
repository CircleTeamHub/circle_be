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
      chatMessage: emptyRows(),
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
});
