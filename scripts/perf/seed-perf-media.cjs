#!/usr/bin/env node
/**
 * 性能测试的图片 / 视频补充数据（在 seed-perf-data.cjs 之后跑，依赖它建好的压测用户）。
 *
 * 给目标账号加：
 *   - 1 个图片视频私聊（对方 perf0445）：600 条，约 60% 图片、20% 视频、20% 文本
 *   - 1 个图片视频群「压测媒体群」：400 条，同样的比例
 *   - 40 条图文笔记：每条 9 张图 + 1 段视频
 *
 * 环境变量和安全闸与 seed-perf-data.cjs 相同；`--clean` 只删本脚本造的行和对象。
 *   --media-dir 目录里要有 cover.jpg、thumb.jpg、video.mp4、poster.jpg
 */
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

const BE_ROOT = process.env.CIRCLE_BE_ROOT || process.cwd();
const beRequire = createRequire(path.join(BE_ROOT, 'package.json'));
const { Client } = beRequire('pg');

const LOCAL_DB_NAME = 'circle_perf';
const REMOTE_DB_NAME = process.env.PERF_REMOTE_DATABASE || '';
const TARGET_ACCOUNT = process.env.PERF_TARGET_ACCOUNT;
if (!TARGET_ACCOUNT) throw new Error('需要 PERF_TARGET_ACCOUNT：要灌数据的那个账号');

const IMAGES = 30; // 每个发送者的不同图片数
const VIDEOS = 6; // 每个发送者的不同视频数
const DIRECT_MESSAGES = 600;
const GROUP_MESSAGES = 400;
const NOTES = 40;
const NOTE_IMAGES = 9;
const SENDER_USERS = [445, 446, 447]; // 加上目标账号自己，一共 4 个发送者

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const pad = (n, width) => String(n).padStart(width, '0');

function readEnv() {
  const file = process.env.PERF_ENV_FILE || path.join(BE_ROOT, '.env.development');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return { ...env, ...process.env };
}

function databaseUrl(env) {
  const url = new URL(env.DATABASE_URL);
  if (REMOTE_DB_NAME) return url.toString();
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('没有 PERF_REMOTE_DATABASE 时只允许连本机数据库。');
  }
  url.pathname = `/${LOCAL_DB_NAME}`;
  return url.toString();
}

const mediaBase = (env) =>
  (env.PERF_MEDIA_BASE || env.OBJECT_STORAGE_DELIVERY_URL || `${env.MINIO_PUBLIC_URL}/${env.MINIO_BUCKET}`).replace(/\/$/, '');

/** 本脚本上传的全部对象：聊天媒体按发送者分目录，笔记媒体放目标账号目录。 */
function objectPlan(targetId, senderIds) {
  const jobs = [];
  for (const sender of senderIds) {
    for (let k = 0; k < IMAGES; k += 1) {
      jobs.push({ Key: `chat/${sender}/perf-img-${pad(k, 2)}.jpg`, file: 'cover.jpg', type: 'image/jpeg' });
      jobs.push({ Key: `chat/${sender}/perf-img-${pad(k, 2)}-thumb.jpg`, file: 'thumb.jpg', type: 'image/jpeg' });
    }
    for (let k = 0; k < VIDEOS; k += 1) {
      jobs.push({ Key: `chat/${sender}/perf-vid-${k}.mp4`, file: 'video.mp4', type: 'video/mp4' });
      jobs.push({ Key: `chat/${sender}/perf-vid-${k}-poster.jpg`, file: 'poster.jpg', type: 'image/jpeg' });
    }
  }
  for (let k = 0; k < IMAGES; k += 1) {
    jobs.push({ Key: `notes/${targetId}/perf-nm-${pad(k, 2)}.jpg`, file: 'cover.jpg', type: 'image/jpeg' });
  }
  for (let k = 0; k < VIDEOS; k += 1) {
    jobs.push({ Key: `notes/${targetId}/perf-nv-${k}.mp4`, file: 'video.mp4', type: 'video/mp4' });
    jobs.push({ Key: `notes/${targetId}/perf-nv-${k}-poster.jpg`, file: 'poster.jpg', type: 'image/jpeg' });
  }
  return jobs;
}

function storage(env) {
  const { S3Client, PutObjectCommand, DeleteObjectCommand } = beRequire('@aws-sdk/client-s3');
  const client = new S3Client({
    endpoint: env.MINIO_ENDPOINT,
    region: env.OBJECT_STORAGE_REGION || 'us-east-1',
    forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE !== 'false',
    credentials: { accessKeyId: env.MINIO_ACCESS_KEY, secretAccessKey: env.MINIO_SECRET_KEY },
  });
  const pool = async (jobs, run) => {
    let next = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < jobs.length) {
          const job = jobs[next];
          next += 1;
          await run(job);
        }
      }),
    );
  };
  return {
    put: (jobs, bodies) =>
      pool(jobs, (job) =>
        client.send(
          new PutObjectCommand({ Bucket: env.MINIO_BUCKET, Key: job.Key, Body: bodies[job.file], ContentType: job.type }),
        ),
      ),
    remove: (jobs) =>
      pool(jobs, (job) => client.send(new DeleteObjectCommand({ Bucket: env.MINIO_BUCKET, Key: job.Key }))),
  };
}

const SETUP_SQL = `
CREATE OR REPLACE FUNCTION pg_temp.pid(key text) RETURNS text AS $$
  SELECT substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12)
  FROM (SELECT md5('circle-perf:'||key) AS h) s
$$ LANGUAGE sql IMMUTABLE;
`;

const CLEAN_SQL = `
DELETE FROM "ChatConversation" WHERE id IN (pg_temp.pid('conv:media:d'), pg_temp.pid('conv:media:g'));
DELETE FROM "Note" WHERE id IN (SELECT pg_temp.pid('medianote:'||n) FROM generate_series(1, ${NOTES}) n);
`;

// 参数：$1 目标账号 id，$2 媒体地址前缀，$3 图片字节数，$4 视频字节数。
// 消息类型按高度取模：0-5 图片，6-7 视频，8-9 文本。
const SEED_SQL = `
CREATE TEMP TABLE media_conv ON COMMIT DROP AS
SELECT pg_temp.pid('conv:media:d') AS id, 'DIRECT' AS kind, ${DIRECT_MESSAGES} AS total, now() - interval '2 minutes' AS last_at
UNION ALL
SELECT pg_temp.pid('conv:media:g'), 'GROUP', ${GROUP_MESSAGES}, now() - interval '5 minutes';

INSERT INTO "ChatConversation"(id, type, "directKey", name, "ownerID", "lastMessageAt",
                               "nextHeight", "createdAt", "updatedAt")
SELECT c.id, c.kind::"ChatConversationType",
       CASE WHEN c.kind = 'DIRECT' THEN
         least($1 COLLATE "C", pg_temp.pid('user:445') COLLATE "C") || ':' ||
         greatest($1 COLLATE "C", pg_temp.pid('user:445') COLLATE "C") END,
       CASE WHEN c.kind = 'GROUP' THEN '压测媒体群' END,
       CASE WHEN c.kind = 'GROUP' THEN $1 END,
       c.last_at, c.total, c.last_at - interval '30 days', c.last_at
FROM media_conv c;

INSERT INTO "ChatMember"(id, "conversationID", "userID", "lastReadHeight", "lastDeliveredHeight", "joinedAt")
SELECT gen_random_uuid()::text, c.id, $1, c.total, c.total, c.last_at - interval '30 days' FROM media_conv c
UNION ALL
SELECT gen_random_uuid()::text, c.id, pg_temp.pid('user:445'), c.total, c.total, c.last_at - interval '30 days'
FROM media_conv c WHERE c.kind = 'DIRECT'
UNION ALL
SELECT gen_random_uuid()::text, c.id, pg_temp.pid('user:'||u), c.total, c.total, c.last_at - interval '30 days'
FROM media_conv c CROSS JOIN generate_series(445, 474) u WHERE c.kind = 'GROUP';

CREATE TEMP TABLE media_msg ON COMMIT DROP AS
SELECT gen_random_uuid()::text AS id, c.id AS conv, h,
       CASE
         WHEN c.kind = 'DIRECT' AND h % 2 = 0 THEN $1
         WHEN c.kind = 'DIRECT' THEN pg_temp.pid('user:445')
         WHEN h % 4 = 0 THEN $1
         ELSE pg_temp.pid('user:'||(444 + (h % 4)))
       END AS sender,
       CASE WHEN h % 10 < 6 THEN 'image' WHEN h % 10 < 8 THEN 'video' ELSE 'text' END AS kind,
       c.last_at - ((c.total - h) * interval '4 minutes') AS created_at
FROM media_conv c CROSS JOIN LATERAL generate_series(1, c.total) h;

INSERT INTO "ChatMessage"(id, "conversationID", height, "senderID", type, content, "createdAt")
SELECT m.id, m.conv, m.h, m.sender, m.kind,
       CASE m.kind
         WHEN 'image' THEN jsonb_build_object(
           'key', 'chat/' || m.sender || '/perf-img-' || lpad((m.h % ${IMAGES})::text, 2, '0') || '.jpg',
           'width', 2048, 'height', 1536,
           'thumbKey', 'chat/' || m.sender || '/perf-img-' || lpad((m.h % ${IMAGES})::text, 2, '0') || '-thumb.jpg')
         WHEN 'video' THEN jsonb_build_object(
           'key', 'chat/' || m.sender || '/perf-vid-' || (m.h % ${VIDEOS}) || '.mp4',
           'size', $4::int, 'width', 720, 'height', 1280, 'duration', 6,
           'thumbKey', 'chat/' || m.sender || '/perf-vid-' || (m.h % ${VIDEOS}) || '-poster.jpg')
         ELSE jsonb_build_object('text', '图片视频会话里的文字 ' || m.h)
       END,
       m.created_at
FROM media_msg m;

INSERT INTO "ChatMediaReference"(id, "messageID", "objectKey")
SELECT gen_random_uuid()::text, cm.id, k.key
FROM "ChatMessage" cm
JOIN media_msg m ON m.id = cm.id
CROSS JOIN LATERAL (VALUES (cm.content ->> 'key'), (cm.content ->> 'thumbKey')) AS k(key)
WHERE m.kind <> 'text' AND k.key IS NOT NULL;

INSERT INTO "Note"(id, "ownerID", title, content, "contentJson", sections, status, pinned,
                   "mediaCount", "imageCount", "videoCount", "createdAt", "updatedAt")
SELECT pg_temp.pid('medianote:'||n), $1, '压测图文笔记 ' || n, body.txt, body.blocks,
       jsonb_build_object(
         'text', jsonb_build_object('content', body.txt, 'contentJson', body.blocks),
         'media', jsonb_build_object('items', items.list)),
       'ACTIVE', false, ${NOTE_IMAGES + 1}, ${NOTE_IMAGES}, 1,
       now() - (n * interval '7 minutes'), now() - (n * interval '7 minutes')
FROM generate_series(1, ${NOTES}) n
CROSS JOIN LATERAL (
  SELECT t.txt, jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid()::text, 'type', 'paragraph',
    'props', jsonb_build_object('textColor', 'default', 'textAlignment', 'left', 'backgroundColor', 'default'),
    'content', jsonb_build_array(jsonb_build_object('text', t.txt, 'type', 'text', 'styles', '{}'::jsonb)),
    'children', '[]'::jsonb)) AS blocks
  FROM (SELECT '这是一条带九张图和一段视频的压测笔记，编号 ' || n AS txt) t
) body
CROSS JOIN LATERAL (
  SELECT jsonb_agg(item ORDER BY ord) AS list FROM (
    SELECT i AS ord, jsonb_build_object(
      'url', $2 || '/notes/' || $1 || '/perf-nm-' || lpad(((n + i) % ${IMAGES})::text, 2, '0') || '.jpg',
      'size', $3::int, 'type', 'IMAGE', 'width', 2048, 'height', 1536, 'mimeType', 'image/jpeg',
      'objectKey', 'notes/' || $1 || '/perf-nm-' || lpad(((n + i) % ${IMAGES})::text, 2, '0') || '.jpg',
      'sortOrder', i) AS item
    FROM generate_series(0, ${NOTE_IMAGES - 1}) i
    UNION ALL
    SELECT ${NOTE_IMAGES}, jsonb_build_object(
      'url', $2 || '/notes/' || $1 || '/perf-nv-' || (n % ${VIDEOS}) || '.mp4',
      'size', $4::int, 'type', 'VIDEO', 'width', 720, 'height', 1280, 'mimeType', 'video/mp4',
      'durationMs', 6000,
      'posterUrl', $2 || '/notes/' || $1 || '/perf-nv-' || (n % ${VIDEOS}) || '-poster.jpg',
      'objectKey', 'notes/' || $1 || '/perf-nv-' || (n % ${VIDEOS}) || '.mp4',
      'sortOrder', ${NOTE_IMAGES})
  ) s
) items;

INSERT INTO "NoteMedia"(id, "noteID", type, "objectKey", url, "mimeType", size, width, height,
                        "durationMs", "posterUrl", "sortOrder")
SELECT pg_temp.pid('medianote:'||n||':'||(item ->> 'sortOrder')), pg_temp.pid('medianote:'||n),
       (item ->> 'type')::"NoteMediaType", item ->> 'objectKey', item ->> 'url', item ->> 'mimeType',
       (item ->> 'size')::int, (item ->> 'width')::int, (item ->> 'height')::int,
       (item ->> 'durationMs')::int, item ->> 'posterUrl', (item ->> 'sortOrder')::int
FROM generate_series(1, ${NOTES}) n
JOIN "Note" note ON note.id = pg_temp.pid('medianote:'||n)
CROSS JOIN LATERAL jsonb_array_elements(note.sections -> 'media' -> 'items') AS item;

UPDATE "Note" SET "coverMediaID" = pg_temp.pid('medianote:'||n||':0')
FROM generate_series(1, ${NOTES}) n WHERE "Note".id = pg_temp.pid('medianote:'||n);
`;

async function runStatements(client, script, all) {
  for (const statement of script.split(/;\s*\n/)) {
    const sql = statement.replace(/^\s*--.*$/gm, '').trim();
    if (!sql) continue;
    const used = [...new Set([...sql.matchAll(/\$(\d)/g)].map((m) => Number(m[1])))].sort();
    let rewritten = sql.replace(/\$([12])\b/g, '$$$1::text');
    used.forEach((original, index) => {
      rewritten = rewritten.replaceAll(`$${original}`, `$__${index + 1}`);
    });
    await client.query(rewritten.replaceAll('$__', '$'), used.map((original) => all[original - 1]));
  }
}

async function main() {
  const env = readEnv();
  const client = new Client({ connectionString: databaseUrl(env) });
  await client.connect();
  try {
    const db = (await client.query('select current_database() as name')).rows[0].name;
    if (db !== (REMOTE_DB_NAME || LOCAL_DB_NAME)) {
      throw new Error(`拒绝写入：当前库是 ${db}，声明的是 ${REMOTE_DB_NAME || LOCAL_DB_NAME}`);
    }
    await client.query(SETUP_SQL);
    const target = await client.query('select id from "User" where "accountId" = $1', [TARGET_ACCOUNT]);
    if (target.rowCount !== 1) throw new Error(`找不到目标账号 ${TARGET_ACCOUNT}`);
    const targetId = target.rows[0].id;
    const senders = (
      await client.query(`select pg_temp.pid('user:'||u) as id from unnest($1::int[]) u`, [SENDER_USERS])
    ).rows.map((row) => row.id);
    const known = await client.query('select count(*)::int as n from "User" where id = any($1::text[])', [senders]);
    if (known.rows[0].n !== SENDER_USERS.length) throw new Error('压测用户还没建，先跑 seed-perf-data.cjs。');
    const jobs = objectPlan(targetId, [targetId, ...senders]);

    if (flag('--clean')) {
      await client.query('BEGIN');
      await runStatements(client, CLEAN_SQL, []);
      await client.query('COMMIT');
      if (!flag('--skip-media')) await storage(env).remove(jobs);
      console.log(JSON.stringify({ cleaned: true, database: db, objects: jobs.length }));
      return;
    }

    let imageBytes = 361455;
    let videoBytes = 1112706;
    if (!flag('--skip-media')) {
      const dir = option('--media-dir');
      if (!dir) throw new Error('需要 --media-dir，或加 --skip-media。');
      const bodies = Object.fromEntries(
        ['cover.jpg', 'thumb.jpg', 'video.mp4', 'poster.jpg'].map((name) => [name, fs.readFileSync(path.join(dir, name))]),
      );
      imageBytes = bodies['cover.jpg'].length;
      videoBytes = bodies['video.mp4'].length;
      await storage(env).put(jobs, bodies);
      const total = jobs.reduce((sum, job) => sum + bodies[job.file].length, 0);
      console.log(`媒体已上传：${jobs.length} 个对象，共 ${(total / 1048576).toFixed(1)} MB`);
    }

    await client.query('BEGIN');
    const params = [targetId, mediaBase(env), imageBytes, videoBytes];
    await runStatements(client, CLEAN_SQL, params);
    await runStatements(client, SEED_SQL, params);
    await client.query('COMMIT');

    const summary = await client.query(
      `select
         (select count(*) from "ChatMessage" where "conversationID" in (pg_temp.pid('conv:media:d'), pg_temp.pid('conv:media:g')) and type = 'image') as images,
         (select count(*) from "ChatMessage" where "conversationID" in (pg_temp.pid('conv:media:d'), pg_temp.pid('conv:media:g')) and type = 'video') as videos,
         (select count(*) from "ChatMediaReference" r join "ChatMessage" m on m.id = r."messageID"
            where m."conversationID" in (pg_temp.pid('conv:media:d'), pg_temp.pid('conv:media:g'))) as media_refs,
         (select count(*) from "Note" where id in (select pg_temp.pid('medianote:'||n) from generate_series(1, ${NOTES}) n)) as media_notes,
         (select count(*) from "NoteMedia" where "noteID" in (select pg_temp.pid('medianote:'||n) from generate_series(1, ${NOTES}) n)) as note_media`,
    );
    console.log(JSON.stringify({ database: db, target: TARGET_ACCOUNT, ...summary.rows[0] }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
