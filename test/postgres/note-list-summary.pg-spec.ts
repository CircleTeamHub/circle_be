import { PrismaPg } from '@prisma/adapter-pg';
import type { ConfigService } from '@nestjs/config';
import { PrismaClient } from 'src/generated/prisma';
import type { PrismaService } from 'src/prisma/prisma.service';
import { NOTE_LIST_DEFAULT_LIMIT } from 'src/note/dto/note.dto';
import { NoteService } from 'src/note/note.service';
import { noteSummaryProjectionQuery } from 'src/note/note-summary.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 笔记列表摘要改成「标量列 select + SQL 投影 + 只签封面」后，在真 PostgreSQL 上与原实现
 * 逐字段对照（listNotes / listDeletedNotes / 公开的 resolveShareLink）：
 * - 原实现照抄改造前的代码：NOTE_INCLUDE 整行 → 收录链 overlay → 补圈子 id → 全量签名
 *   → 原 mapSummary（逐行照抄在下面）；新实现就是 NoteService 本身，跑真的 PrismaClient；
 * - 覆盖纯文字、长文、开头大段空白（要补读正文）、预览 120 字边界、代理对、Unicode 空白、
 *   控制字符、带媒体 / 封面回退、带名片（含坏数据与旧圈子卡片）、各种显式分区与畸形
 *   sections、正文块数组、分组、收录副本、回收站、分享链接（访客视角）；
 * - 两边的 DTO 序列化后逐字节相同（字段顺序也一样），并且新实现签名的对象只剩封面、
 *   搬回来的数据量小一个数量级。
 */
const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;

const NOTE_INCLUDE_BEFORE = {
  media: { orderBy: { sortOrder: 'asc' } },
  coverMedia: { select: { id: true, type: true, url: true } },
  groupMemberships: {
    where: { group: { deletedAt: null } },
    include: { group: { select: { id: true, name: true } } },
  },
} as const;

type Svc = Record<string, (...args: any[]) => any>;

/** 改造前的 mapSummary，逐行照抄；它调用的私有工具方法本次没有改动。 */
function oldMapSummary(
  svc: Svc,
  note: any,
  viewerID: string,
  presignedUrls?: Map<string, string>,
) {
  const isOwner = note.ownerID === viewerID;
  const groups = isOwner
    ? (note.groupMemberships ?? []).map((membership: any) => ({
        id: membership.group.id,
        name: membership.group.name,
      }))
    : [];
  const fallbackCoverMedia =
    note.media?.find((item: any) => item.type === 'IMAGE') ?? null;
  const coverMedia =
    note.coverMedia?.type === 'IMAGE' ? note.coverMedia : fallbackCoverMedia;
  const sections = svc.buildSectionsFromRow(note, presignedUrls);
  const visibleSections = isOwner
    ? sections
    : {
        ...sections,
        contacts: { items: [] },
        groups: { items: [] },
      };
  const availability = svc.getSectionAvailability(visibleSections);
  const cardPreview = {
    contacts: svc.toCardPeers(visibleSections.contacts?.items),
    groups: svc.toCardPeers(visibleSections.groups?.items, true),
  };

  return {
    id: note.id,
    ownerId: note.ownerID,
    canEdit: isOwner,
    title: note.title,
    contentPreview: svc.buildPreview(note.content),
    status: note.status,
    available: note.available,
    workStatus: note.workStatus ?? null,
    sourceConversationID: isOwner ? (note.sourceConversationID ?? null) : null,
    pinned: isOwner ? note.pinned : false,
    remark: isOwner ? (note.remark ?? null) : null,
    groups,
    cover: coverMedia
      ? {
          id: coverMedia.id,
          type: coverMedia.type,
          url:
            (presignedUrls && typeof coverMedia.url === 'string'
              ? presignedUrls.get(coverMedia.url)
              : undefined) ?? coverMedia.url,
        }
      : null,
    imageCount: note.imageCount,
    videoCount: note.videoCount,
    audioCount: note.audioCount ?? 0,
    mediaCount: note.mediaCount,
    ...availability,
    cardPreview,
    collectedFrom:
      isOwner && svc.isRecord(note.collectedFrom) ? note.collectedFrom : null,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

describePostgres('note list summaries (PostgreSQL)', () => {
  let s: IsolatedSchema;
  let prisma: PrismaClient;
  let service: NoteService;
  let svc: Svc;
  const signed: string[] = [];
  const noteFindMany: unknown[] = [];

  const upload = {
    createPresignedGetUrl: (key: string) => {
      signed.push(key);
      return Promise.resolve({ url: `https://signed.test/${key}` });
    },
    objectKeyFromPublicUrl: (url: unknown) =>
      typeof url === 'string'
        ? (url.split('/circle/')[1]?.split('?')[0] ?? null)
        : null,
  };

  /** 改造前 mapSummaryListResolved。 */
  const oldSummaries = async (rows: any[], viewerID: string) => {
    const effective = await svc.withLegacyCircleIds(
      await svc.overlayCollectedSourceState(rows),
    );
    const presigned = await svc.presignNoteMedia(
      effective.flatMap((note: any) => svc.collectNoteMediaTargets(note)),
    );
    return effective.map((note: any) =>
      oldMapSummary(svc, note, viewerID, presigned),
    );
  };
  const oldPage = async (rows: any[], limit: number, viewerID: string) => {
    const hasMore = rows.length > limit;
    return {
      items: await oldSummaries(
        hasMore ? rows.slice(0, limit) : rows,
        viewerID,
      ),
      hasMore,
    };
  };

  /** 改造前 listNotes（where / orderBy / 分页照抄，include NOTE_INCLUDE）。 */
  const oldListNotes = async (
    ownerID: string,
    query: {
      status?: 'ACTIVE' | 'UNLISTED';
      groupId?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ) => {
    const limit = query.limit ?? NOTE_LIST_DEFAULT_LIMIT;
    const page = query.page ?? 1;
    const notes = await prisma.note.findMany({
      where: {
        ownerID,
        status: query.status ?? { not: 'DELETED' },
        ...(query.groupId
          ? {
              groupMemberships: {
                some: { groupID: query.groupId, group: { deletedAt: null } },
              },
            }
          : {}),
        ...(query.search?.trim()
          ? {
              OR: [
                {
                  title: {
                    contains: query.search.trim(),
                    mode: 'insensitive' as const,
                  },
                },
                {
                  content: {
                    contains: query.search.trim(),
                    mode: 'insensitive' as const,
                  },
                },
              ],
            }
          : {}),
      },
      include: NOTE_INCLUDE_BEFORE,
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      take: limit + 1,
      skip: (page - 1) * limit,
    });
    return oldPage(notes, limit, ownerID);
  };

  const oldListDeleted = async (ownerID: string, page = 1, limit = 500) => {
    const take = Math.min(limit, NOTE_LIST_DEFAULT_LIMIT);
    const notes = await prisma.note.findMany({
      where: { ownerID, status: 'DELETED' },
      orderBy: { updatedAt: 'desc' },
      take: take + 1,
      skip: (page - 1) * take,
      include: NOTE_INCLUDE_BEFORE,
    });
    return oldPage(notes, take, ownerID);
  };

  const oldResolveShareLink = async (token: string) => {
    const link = await prisma.noteShareLink.findUnique({ where: { token } });
    const notes = await prisma.note.findMany({
      where: svc.buildShareLinkNoteFilter(link),
      include: NOTE_INCLUDE_BEFORE,
      orderBy: [{ updatedAt: 'desc' }],
      take: 200,
    });
    const effectiveNotes = await svc.overlayCollectedSourceState(notes);
    const distributable = notes.filter((_note: unknown, index: number) =>
      svc.isDistributable(effectiveNotes[index]),
    );
    return {
      title: link!.title,
      notes: await oldSummaries(distributable, ''),
      expiresAt: link!.expiresAt,
    };
  };

  /** 新旧各跑一遍：DTO 逐字节一致；返回两边签名的对象数。 */
  const compare = async (
    run: () => Promise<unknown>,
    runOld: () => Promise<unknown>,
  ) => {
    signed.length = 0;
    const expected = await runOld();
    const oldSigned = signed.length;
    signed.length = 0;
    const actual = await run();
    const newSigned = signed.length;
    expect(actual).toStrictEqual(expected);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    return { expected, oldSigned, newSigned };
  };

  let order = 0;
  const note = async (
    id: string,
    fields: {
      ownerID?: string;
      title?: string;
      content?: string | null;
      contentJson?: unknown;
      sections?: unknown;
      status?: string;
      available?: boolean;
      workStatus?: string | null;
      pinned?: boolean;
      coverMediaID?: string | null;
      remark?: string | null;
      collectedFrom?: unknown;
      collectedFromNoteID?: string | null;
      rootSourceNoteID?: string | null;
      sourceConversationID?: string | null;
      counts?: [number, number, number, number];
    } = {},
  ) => {
    order += 1;
    const [mediaCount, imageCount, videoCount, audioCount] = fields.counts ?? [
      0, 0, 0, 0,
    ];
    await s.db.query(
      `INSERT INTO "Note" (id, "ownerID", title, content, "contentJson", sections, status,
         available, "workStatus", pinned, "coverMediaID", remark, "collectedFrom",
         "collectedFromNoteID", "sourceConversationID", "mediaCount", "imageCount",
         "videoCount", "audioCount", "createdAt", "updatedAt", "rootSourceNoteID")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::jsonb,
               $14, $15, $16, $17, $18, $19,
               TIMESTAMP '2026-01-01' + ($20 || ' minutes')::interval,
               TIMESTAMP '2026-02-01' + ($20 || ' minutes')::interval, $21)`,
      [
        id,
        fields.ownerID ?? 'u1',
        fields.title ?? `title ${id}`,
        fields.content === undefined ? `content of ${id}` : fields.content,
        fields.contentJson === undefined
          ? null
          : JSON.stringify(fields.contentJson),
        fields.sections === undefined ? null : JSON.stringify(fields.sections),
        fields.status ?? 'ACTIVE',
        fields.available ?? true,
        fields.workStatus ?? null,
        fields.pinned ?? false,
        fields.coverMediaID ?? null,
        fields.remark ?? null,
        fields.collectedFrom === undefined
          ? null
          : JSON.stringify(fields.collectedFrom),
        fields.collectedFromNoteID ?? null,
        fields.sourceConversationID ?? null,
        mediaCount,
        imageCount,
        videoCount,
        audioCount,
        String(order),
        // 收藏副本的根:写路径和回填都会填,这里默认跟直接来源一致(单层收藏)。
        fields.rootSourceNoteID === undefined
          ? (fields.collectedFromNoteID ?? null)
          : fields.rootSourceNoteID,
      ],
    );
  };
  const media = (
    id: string,
    noteID: string,
    type: 'IMAGE' | 'VIDEO' | 'AUDIO',
    sortOrder: number,
    posterUrl: string | null = null,
  ) =>
    s.db.query(
      `INSERT INTO "NoteMedia" (id, "noteID", type, "objectKey", url, "posterUrl", "sortOrder")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        noteID,
        type,
        `notes/u1/${id}.bin`,
        `https://api.test/circle/notes/u1/${id}.bin`,
        posterUrl,
        sortOrder,
      ],
    );
  const contact = (n: number) => ({
    id: `user-${n}`,
    name: `联系人${n}`,
    faceURL: `https://api.test/circle/avatars/u${n}.jpg`,
  });

  beforeAll(async () => {
    s = await openIsolatedSchema('note_list');
    await s.db.query(`
      CREATE TYPE "NoteStatus" AS ENUM ('ACTIVE', 'UNLISTED', 'DELETED');
      CREATE TYPE "NoteWorkStatus" AS ENUM ('WORKING', 'CLOSED');
      CREATE TYPE "NoteMediaType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO');
      CREATE TABLE "Note" (
        id text PRIMARY KEY,
        "ownerID" text NOT NULL,
        "clientDraftID" text,
        "groupID" text,
        title text NOT NULL,
        content text,
        "contentJson" jsonb,
        sections jsonb,
        status "NoteStatus" NOT NULL DEFAULT 'ACTIVE',
        available boolean NOT NULL DEFAULT true,
        "workStatus" "NoteWorkStatus",
        "sourceConversationID" text,
        pinned boolean NOT NULL DEFAULT false,
        "coverMediaID" text UNIQUE,
        "mediaCount" integer NOT NULL DEFAULT 0,
        "imageCount" integer NOT NULL DEFAULT 0,
        "videoCount" integer NOT NULL DEFAULT 0,
        "audioCount" integer NOT NULL DEFAULT 0,
        remark text,
        "collectedFrom" jsonb,
        "collectedFromNoteID" text,
        "rootSourceNoteID" text,
        "createdAt" timestamp(3) NOT NULL,
        "updatedAt" timestamp(3) NOT NULL
      );
      CREATE INDEX "Note_ownerID_pinned_updatedAt_idx" ON "Note" ("ownerID", pinned, "updatedAt");
      CREATE INDEX "Note_ownerID_status_updatedAt_idx" ON "Note" ("ownerID", status, "updatedAt");
      CREATE TABLE "NoteMedia" (
        id text PRIMARY KEY,
        "noteID" text NOT NULL,
        type "NoteMediaType" NOT NULL,
        "objectKey" text NOT NULL,
        url text NOT NULL,
        "mimeType" text,
        size integer,
        width integer,
        height integer,
        "durationMs" integer,
        "posterUrl" text,
        "sortOrder" integer NOT NULL,
        "createdAt" timestamp(3) NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "NoteMedia_noteID_sortOrder_key" ON "NoteMedia" ("noteID", "sortOrder");
      CREATE TABLE "NoteGroup" (
        id text PRIMARY KEY,
        "ownerID" text NOT NULL,
        name text NOT NULL,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "deletedAt" timestamp(3),
        "createdAt" timestamp(3) NOT NULL DEFAULT now(),
        "updatedAt" timestamp(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE "NoteGroupMembership" (
        id text PRIMARY KEY,
        "noteID" text NOT NULL,
        "groupID" text NOT NULL,
        "createdAt" timestamp(3) NOT NULL DEFAULT now()
      );
      CREATE TABLE "Circle" (id text PRIMARY KEY, "groupID" text);
      CREATE TABLE "NoteShareLink" (
        id text PRIMARY KEY,
        "ownerID" text NOT NULL,
        token text NOT NULL UNIQUE,
        title text NOT NULL,
        status "NoteStatus",
        "group" text,
        "groupID" text,
        search text,
        "noteIDs" text[] NOT NULL DEFAULT '{}',
        "expiresAt" timestamp(3),
        "revokedAt" timestamp(3),
        "createdAt" timestamp(3) NOT NULL DEFAULT now(),
        "updatedAt" timestamp(3) NOT NULL DEFAULT now()
      );
    `);

    prisma = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: databaseUrl,
          options: `-c search_path="${s.schema}",public`,
        },
        { schema: s.schema },
      ),
    });
    // 记下 service 发出的 note.findMany，确认补读正文那一条确实跑过。
    const recordingPrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'note') return value;
        return new Proxy(value as object, {
          get(delegate, method) {
            const fn = Reflect.get(delegate, method);
            if (method !== 'findMany') return fn;
            return (args: unknown) => {
              noteFindMany.push(args);
              return (fn as (args: unknown) => unknown).call(delegate, args);
            };
          },
        });
      },
    });
    service = new NoteService(
      recordingPrisma as unknown as PrismaService,
      {
        get: (key: string) =>
          key === 'NOTE_SHARE_WEB_BASE' ? 'https://share.test' : undefined,
      } as unknown as ConfigService,
      {} as never,
      {} as never,
      upload as never,
    );
    svc = service as unknown as Svc;

    // ── 正文 ────────────────────────────────────────────────────────────────
    await note('n-plain', { content: 'Hello  world\n\n  second line' });
    await note('n-long', { content: 'abc '.repeat(600) });
    // 开头 1500 个换行：开头 1024 个字符压缩后是空串，必须补读整段。
    await note('n-ws-head', { content: `${'\n'.repeat(1500)}tail words here` });
    await note('n-ws-exact', {
      content: `${' '.repeat(1100)}${'x'.repeat(50)}`,
    });
    // 压缩后恰好 120 / 121 个字符的开头。
    await note('n-boundary-120', {
      content: `${'y'.repeat(120)}${' '.repeat(1000)}z`,
    });
    await note('n-boundary-121', {
      content: `${'y'.repeat(121)}${' '.repeat(1000)}`,
    });
    await note('n-exact-1024', { content: 'w'.repeat(1024) });
    await note('n-emoji', { content: '😀'.repeat(200) });
    await note('n-emoji-long', { content: `${'😀'.repeat(1100)}tail` });
    await note('n-emoji-ws', {
      content: `${'　'.repeat(1030)}😀${'\t'.repeat(10)}😀`,
    });
    await note('n-unicode-ws', { content: '　 ﻿  \t' });
    // 控制字符：预览把它当空白（null），trim 不认它（hasText = true）。
    await note('n-control', { content: '\u0001\u0002' });
    await note('n-empty', { content: '' });
    await note('n-null', { content: null });

    // ── 媒体与封面 ──────────────────────────────────────────────────────────
    await note('n-media', {
      coverMediaID: 'm-video',
      counts: [4, 2, 1, 1],
    });
    await media('m-img-b', 'n-media', 'IMAGE', 2);
    await media('m-img-a', 'n-media', 'IMAGE', 0);
    await media(
      'm-video',
      'n-media',
      'VIDEO',
      1,
      'https://api.test/circle/notes/u1/m-video-poster.jpg',
    );
    await media('m-audio', 'n-media', 'AUDIO', 3);
    await note('n-cover', { coverMediaID: 'm-c1', counts: [2, 2, 0, 0] });
    await media('m-c0', 'n-cover', 'IMAGE', 0);
    await media('m-c1', 'n-cover', 'IMAGE', 1);
    await note('n-video-only', { counts: [1, 0, 1, 0] });
    await media('m-v', 'n-video-only', 'VIDEO', 0);

    // ── 名片 ────────────────────────────────────────────────────────────────
    await s.db.query(
      `INSERT INTO "Circle" (id, "groupID") VALUES ('circle-legacy', 'chat-group-legacy')`,
    );
    await note('n-cards', {
      sections: {
        contacts: {
          items: [
            null,
            { id: '', name: '缺 id' },
            'not a card',
            contact(1),
            { id: ' user-9 ', name: ' 有空格 ', avatarUrl: 'https://a.test/9' },
            contact(2),
            contact(3),
            contact(4),
          ],
        },
        groups: {
          items: [
            // 旧版圈子卡片：没有 circleId，按 Circle.groupID 补。
            { id: 'chat-group-legacy', name: '旧圈子', faceURL: '' },
            { id: 'chat-group-unknown', name: '查不到的旧圈子' },
            {
              id: 'conv-standalone',
              name: '独立群',
              faceURL: null,
              conversationID: 'conv-standalone',
            },
            { id: 'g-4', name: '第四张', circleId: 'circle-4' },
          ],
        },
      },
    });

    // ── 显式分区与畸形 sections ─────────────────────────────────────────────
    await note('n-sections-text', {
      content: 'real text',
      sections: {
        text: { content: '   ', contentJson: [] },
        showcase: {
          items: [
            {
              url: 'https://api.test/circle/notes/u1/s.jpg',
              objectKey: 'notes/u1/s.jpg',
            },
            'x',
          ],
        },
        media: { items: [] },
        location: {},
      },
    });
    await note('n-sections-json', {
      content: null,
      sections: { text: { contentJson: [1, 'x', { type: 'paragraph' }] } },
    });
    await note('n-json-root', { content: null, contentJson: [[], null, 5] });
    await note('n-json-root-obj', {
      content: '   ',
      contentJson: [{ type: 'paragraph' }],
    });
    await note('n-sections-array', { sections: [], counts: [1, 1, 0, 0] });
    await media('m-sa', 'n-sections-array', 'IMAGE', 0);
    await note('n-sections-string', { sections: 'just a string' });
    await note('n-sections-odd', {
      sections: {
        contacts: [contact(1)],
        location: [1],
        showcase: { items: 'x' },
        media: { items: [] },
      },
      counts: [1, 1, 0, 0],
    });
    await media('m-so', 'n-sections-odd', 'IMAGE', 0);
    await note('n-section-text-number', {
      content: 'hi',
      sections: { text: { content: 123 } },
    });
    await note('n-section-text-ws', {
      content: null,
      sections: { text: { content: '　x' }, location: { title: 't' } },
    });
    await note('n-section-json-null', {
      content: null,
      contentJson: [{}],
      sections: { text: { contentJson: null } },
    });

    // ── 分组、收录副本、状态 ────────────────────────────────────────────────
    await s.db.query(`
      INSERT INTO "NoteGroup" (id, "ownerID", name) VALUES ('g1', 'u1', '上海');
      INSERT INTO "NoteGroup" (id, "ownerID", name, "deletedAt") VALUES ('g2', 'u1', '已删分组', now());
      INSERT INTO "NoteGroupMembership" (id, "noteID", "groupID") VALUES
        ('gm1', 'n-plain', 'g1'), ('gm2', 'n-plain', 'g2'), ('gm3', 'n-media', 'g1'),
        ('gm4', 'n-unlisted', 'g1');
    `);
    await note('n-unlisted', {
      status: 'UNLISTED',
      pinned: true,
      remark: '私人备注',
      workStatus: 'WORKING',
      sourceConversationID: 'conv-1',
    });
    await note('src-1', { ownerID: 'u2', status: 'UNLISTED' });
    await note('n-copy', {
      collectedFromNoteID: 'src-1',
      collectedFrom: { groupName: '私密来源群' },
    });
    await note('n-copy-purged', { collectedFromNoteID: 'gone-forever' });

    // ── 回收站 ──────────────────────────────────────────────────────────────
    await note('d-1', { status: 'DELETED', counts: [1, 1, 0, 0] });
    await media('m-d1', 'd-1', 'IMAGE', 0);
    await note('d-2', {
      status: 'DELETED',
      sections: { contacts: { items: [contact(7)] } },
    });

    // ── 大笔记：2 万字正文、大块 contentJson、sections 里的副本、50 张图 ──────────
    const blocks = Array.from({ length: 400 }, (_, i) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: `段落 ${i} ${'内容'.repeat(20)}` }],
    }));
    await note('n-big', {
      content: '长文'.repeat(9_500),
      contentJson: blocks,
      sections: {
        text: { content: '长文'.repeat(9_500), contentJson: blocks },
        media: {
          items: Array.from({ length: 50 }, (_, i) => ({
            url: `https://api.test/circle/notes/u1/m-big-${i}.bin`,
            objectKey: `notes/u1/m-big-${i}.bin`,
          })),
        },
      },
      counts: [50, 50, 0, 0],
    });
    for (let i = 0; i < 50; i += 1) {
      await media(`m-big-${i}`, 'n-big', 'IMAGE', i);
    }

    // ── 分享链接 ────────────────────────────────────────────────────────────
    await s.db.query(`
      INSERT INTO "NoteShareLink" (id, "ownerID", token, title, "noteIDs") VALUES
        ('l1', 'u1', 'tok-all', '全部', '{}'),
        ('l2', 'u1', 'tok-some', '部分', '{n-cards,n-copy,n-copy-purged,n-media,n-unlisted}');
      INSERT INTO "NoteShareLink" (id, "ownerID", token, title, status, "groupID") VALUES
        ('l3', 'u1', 'tok-unlisted-g1', '分组', 'UNLISTED', 'g1');
    `);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await s?.close();
  });

  it('lists the default page exactly like the full-row implementation, signing only covers', async () => {
    noteFindMany.length = 0;
    const { expected, oldSigned, newSigned } = await compare(
      () => service.listNotes('u1', {}),
      () => oldListNotes('u1', {}),
    );
    const page = expected as { items: Array<Record<string, unknown>> };
    expect(page.items.length).toBeGreaterThan(30);
    // 补读正文：只针对开头 1024 个字符定不出预览的那几条。
    const contentReads = noteFindMany.filter(
      (args) =>
        (args as { select?: Record<string, unknown> }).select?.content === true,
    ) as Array<{ where: { id: { in: string[] } } }>;
    expect(contentReads).toHaveLength(1);
    expect([...contentReads[0].where.id.in].sort()).toEqual(
      ['n-boundary-120', 'n-emoji-ws', 'n-ws-exact', 'n-ws-head'].sort(),
    );
    // 原实现签了每张媒体、poster 和分区条目；现在只签封面。
    const covers = page.items.filter((item) => item.cover !== null).length;
    expect(newSigned).toBe(covers);
    expect(oldSigned).toBeGreaterThan(newSigned * 5);

    const byId = new Map(page.items.map((item) => [item.id, item]));
    // 抽查几条边界，证明对照覆盖到了。
    expect(byId.get('n-ws-head')!.contentPreview).toBe('tail words here');
    expect(byId.get('n-boundary-120')!.contentPreview).toBe(
      `${'y'.repeat(120)}...`,
    );
    expect(byId.get('n-control')).toMatchObject({
      contentPreview: null,
      hasText: true,
    });
    expect(byId.get('n-sections-text')).toMatchObject({
      hasText: false,
      showcaseCount: 2,
      hasLocation: true,
    });
    expect(byId.get('n-media')!.cover).toEqual({
      id: 'm-img-a',
      type: 'IMAGE',
      url: 'https://signed.test/notes/u1/m-img-a.bin',
    });
    expect(byId.get('n-cards')!.contactCount).toBe(6);
    expect(
      (byId.get('n-cards')!.cardPreview as { groups: unknown[] }).groups[0],
    ).toMatchObject({ id: 'chat-group-legacy', circleId: 'circle-legacy' });
  });

  it('pages, filters and searches exactly like the full-row implementation', async () => {
    for (let page = 1; page <= 9; page += 1) {
      await compare(
        () => service.listNotes('u1', { page, limit: 5 }),
        () => oldListNotes('u1', { page, limit: 5 }),
      );
    }
    await compare(
      () => service.listNotes('u1', { status: 'UNLISTED' }),
      () => oldListNotes('u1', { status: 'UNLISTED' }),
    );
    await compare(
      () => service.listNotes('u1', { search: 'WORDS' }),
      () => oldListNotes('u1', { search: 'WORDS' }),
    );
    await compare(
      () => service.listNotes('u1', { groupId: 'g1' }),
      () => oldListNotes('u1', { groupId: 'g1' }),
    );
  });

  it('lists the recycle bin exactly like the full-row implementation', async () => {
    const { expected } = await compare(
      () => service.listDeletedNotes('u1'),
      () => oldListDeleted('u1'),
    );
    expect((expected as { items: unknown[] }).items).toHaveLength(2);
    await compare(
      () => service.listDeletedNotes('u1', 2, 1),
      () => oldListDeleted('u1', 2, 1),
    );
  });

  it('resolves share links for a guest exactly like the full-row implementation', async () => {
    for (const token of ['tok-all', 'tok-some', 'tok-unlisted-g1']) {
      const { expected } = await compare(
        () => service.resolveShareLink(token),
        () => oldResolveShareLink(token),
      );
      const { notes } = expected as {
        notes: Array<{ id: string; contactCount: number; canEdit: boolean }>;
      };
      expect(notes.length).toBeGreaterThan(0);
      // 访客视角：名片、编辑权限都不外发；来源已下架的副本被滤掉。
      expect(
        notes.every((item) => !item.canEdit && item.contactCount === 0),
      ).toBe(true);
      expect(notes.map((item) => item.id)).not.toContain('n-copy');
    }
  });

  it('reads a page of summaries by primary key and carries a fraction of the row data', async () => {
    await s.db.query(`
      INSERT INTO "Note" (id, "ownerID", title, content, "createdAt", "updatedAt")
      SELECT 'filler-' || g, 'u3', 't', repeat('x', 200), now(), now()
      FROM generate_series(1, 3000) g;
      INSERT INTO "NoteMedia" (id, "noteID", type, "objectKey", url, "sortOrder")
      SELECT 'fm-' || g || '-' || i, 'filler-' || g, 'IMAGE', 'k', 'u', i
      FROM generate_series(1, 3000) g, generate_series(0, 3) i;
      ANALYZE "Note"; ANALYZE "NoteMedia";
    `);
    const ids = ['n-big', 'n-media', 'n-cover', 'n-cards', 'n-plain'];
    const query = noteSummaryProjectionQuery(ids);
    const plan = await explainPlan(s.db, query.text, query.values);
    expect(plan).toContain('"Index Name":"Note_pkey"');
    expect(plan).toContain('"Index Name":"NoteMedia_noteID_sortOrder_key"');
    expect(plan).not.toMatch(
      /"Node Type":"Seq Scan"[^}]*"Relation Name":"Note"/,
    );

    // 原来整行搬回来的数据量 vs. 现在标量列 + 投影。
    const oldRows = await prisma.note.findMany({
      where: { id: { in: ids } },
      include: NOTE_INCLUDE_BEFORE,
    });
    const { rows: projected } = await s.db.query(query.text, query.values);
    const newRows = await prisma.note.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        ownerID: true,
        title: true,
        status: true,
        available: true,
        workStatus: true,
        pinned: true,
        remark: true,
        imageCount: true,
        videoCount: true,
        audioCount: true,
        mediaCount: true,
        collectedFrom: true,
        collectedFromNoteID: true,
        rootSourceNoteID: true,
        createdAt: true,
        updatedAt: true,
        groupMemberships: {
          where: { group: { deletedAt: null } },
          select: { group: { select: { id: true, name: true } } },
        },
      },
    });
    const oldBytes = JSON.stringify(oldRows).length;
    const newBytes = JSON.stringify([newRows, projected]).length;
    expect(newBytes * 10).toBeLessThan(oldBytes);
  }, 120_000);
});
