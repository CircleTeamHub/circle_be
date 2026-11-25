#!/usr/bin/env node
/**
 * 前端大数据量性能测试的造数脚本。
 *
 * 给目标账号灌入：
 *   - 600 个压测用户（perf0001..perf0600，各有独立头像地址）
 *   - 440 个私聊 + 60 个群聊，每个 200 条文本消息；第 1 个私聊 5000 条（深历史）
 *   - 500 条笔记，约 70% 带封面，8 个分组
 *
 * 可重复执行；`--clean` 把它造的行和对象全部删掉（含它自己建的目标账号）。
 *
 * 本机（默认）：只连 localhost，库名必须是 circle_perf。
 *   PERF_TARGET_ACCOUNT=<账号> node seed-perf-data.cjs --media-dir <含 cover.jpg / avatar.jpg 的目录>
 *
 * 测试服（在 circle_be 容器里跑）：必须显式写出要动的库名，对不上就拒绝。
 *   PERF_REMOTE_DATABASE=circle PERF_ENV_FILE=/app/.env.production \
 *   PERF_TARGET_ACCOUNT=<压测账号> PERF_TARGET_PASSWORD=... \
 *   node seed-perf-data.cjs --media-dir /tmp/perf-media
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

const USERS = 600;
const FRIENDS = 450;
const DIRECTS = 440;
const GROUPS = 60;
const GROUP_MEMBERS = 30;
const MESSAGES = 200;
const DEEP_MESSAGES = 5000;
const NOTES = 500;
const COVERS = 100;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

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

function mediaBase(env) {
  const base =
    env.PERF_MEDIA_BASE ||
    env.OBJECT_STORAGE_DELIVERY_URL ||
    `${env.MINIO_PUBLIC_URL}/${env.MINIO_BUCKET}`;
  return base.replace(/\/$/, '');
}

function mediaKeys(targetId) {
  return {
    covers: Array.from(
      { length: COVERS },
      (_, i) => `notes/${targetId}/perf-cover-${String(i).padStart(3, '0')}.jpg`,
    ),
    avatars: Array.from(
      { length: USERS },
      (_, i) => `avatars/perf/avatar-${String(i + 1).padStart(4, '0')}.jpg`,
    ),
  };
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
      Array.from({ length: 12 }, async () => {
        while (next < jobs.length) {
          const job = jobs[next];
          next += 1;
          await run(job);
        }
      }),
    );
  };
  return {
    put: (jobs) =>
      pool(jobs, (job) =>
        client.send(
          new PutObjectCommand({ Bucket: env.MINIO_BUCKET, ContentType: 'image/jpeg', ...job }),
        ),
      ),
    remove: (keys) =>
      pool(keys, (Key) => client.send(new DeleteObjectCommand({ Bucket: env.MINIO_BUCKET, Key }))),
  };
}

const SETUP_SQL = `
CREATE OR REPLACE FUNCTION pg_temp.pid(key text) RETURNS text AS $$
  SELECT substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12)
  FROM (SELECT md5('circle-perf:'||key) AS h) s
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION pg_temp.phrase(n int) RETURNS text AS $$
  SELECT (ARRAY[
    '好的', '收到～', '晚上一起吃饭吗？', '哈哈哈哈哈哈', '在吗', '👌', '明天几点？',
    '我到楼下了，你下来吧', '刚开完会，晚点回你', '这个方案我看了，整体没问题，就是第二部分的时间排得有点紧，能不能往后挪两天',
    '🎉🎉🎉', '图片我发群里了', '周末去爬山怎么样，天气预报说是晴天，早上七点出发的话中午就能到山顶',
    '嗯嗯', '稍等', '没问题', '那就这么定了', '你看一下我刚发的笔记', '谢谢！', '路上堵车，可能要晚十分钟'
  ])[1 + (n % 20)] || CASE WHEN n % 11 = 0 THEN ' #' || n ELSE '' END
$$ LANGUAGE sql IMMUTABLE;
`;

// 参数：$1 密码哈希，$2 目标账号 id，$3 媒体地址前缀，$4 封面字节数。
const CLEAN_SQL = `
DELETE FROM "ChatConversation" WHERE id IN (
  SELECT pg_temp.pid('conv:d:'||i) FROM generate_series(1, ${DIRECTS}) i
  UNION ALL SELECT pg_temp.pid('conv:g:'||j) FROM generate_series(1, ${GROUPS}) j);
DELETE FROM "Note" WHERE id IN (SELECT pg_temp.pid('note:'||n) FROM generate_series(1, ${NOTES}) n);
DELETE FROM "NoteGroup" WHERE id IN (SELECT pg_temp.pid('notegroup:'||g) FROM generate_series(0, 7) g);
DELETE FROM "User" WHERE "accountId" ~ '^perf[0-9]{4}$';
`;

const SEED_SQL = `
INSERT INTO "User"(id, "accountId", "inviteCode", "passwordHash", nickname, "avatarUrl", "updatedAt")
SELECT pg_temp.pid('user:'||i),
       'perf'||lpad(i::text, 4, '0'),
       'PERF'||lpad(i::text, 4, '0'),
       $1,
       (ARRAY['小','阿','老','大','晓','子','一','安','可','乐'])[1 + (i % 10)]
         || (ARRAY['明','芳','伟','静','磊','娜','杰','婷','涛','雪','峰','琳','超'])[1 + ((i / 10) % 13)]
         || CASE WHEN i % 5 = 0 THEN '🌟' ELSE '' END || ' ' || i,
       $3 || '/avatars/perf/avatar-' || lpad(i::text, 4, '0') || '.jpg',
       now()
FROM generate_series(1, ${USERS}) i;

INSERT INTO "Friend"(id, "userID", "friendID", state, "updatedAt")
SELECT pg_temp.pid('friend:'||i), $2, pg_temp.pid('user:'||i), 'ACCEPTED', now()
FROM generate_series(1, ${FRIENDS}) i;

CREATE TEMP TABLE perf_conv ON COMMIT DROP AS
SELECT pg_temp.pid('conv:d:'||i) AS id, 'DIRECT' AS kind, i AS n,
       CASE WHEN i = 1 THEN ${DEEP_MESSAGES} ELSE ${MESSAGES} END AS total,
       now() - (i * interval '37 minutes') AS last_at
FROM generate_series(1, ${DIRECTS}) i
UNION ALL
SELECT pg_temp.pid('conv:g:'||j), 'GROUP', j, ${MESSAGES},
       now() - (j * interval '5 hours') - interval '13 minutes'
FROM generate_series(1, ${GROUPS}) j;

INSERT INTO "ChatConversation"(id, type, "directKey", name, "ownerID", "lastMessageAt",
                               "nextHeight", "createdAt", "updatedAt")
SELECT c.id, c.kind::"ChatConversationType",
       CASE WHEN c.kind = 'DIRECT' THEN
         least($2 COLLATE "C", pg_temp.pid('user:'||c.n) COLLATE "C") || ':' ||
         greatest($2 COLLATE "C", pg_temp.pid('user:'||c.n) COLLATE "C") END,
       CASE WHEN c.kind = 'GROUP' THEN '压测群 ' || c.n END,
       CASE WHEN c.kind = 'GROUP' THEN
         CASE WHEN c.n <= 10 THEN $2 ELSE pg_temp.pid('user:'||c.n) END END,
       c.last_at, c.total, c.last_at - interval '60 days', c.last_at
FROM perf_conv c;

INSERT INTO "ChatMember"(id, "conversationID", "userID", "lastReadHeight", "lastDeliveredHeight", "joinedAt")
SELECT gen_random_uuid()::text, c.id, $2,
       c.total - CASE WHEN c.n % 4 = 0 THEN (c.n % 37) + 1 ELSE 0 END,
       c.total, c.last_at - interval '60 days'
FROM perf_conv c
UNION ALL
SELECT gen_random_uuid()::text, c.id, pg_temp.pid('user:'||c.n), c.total, c.total,
       c.last_at - interval '60 days'
FROM perf_conv c WHERE c.kind = 'DIRECT'
UNION ALL
SELECT gen_random_uuid()::text, c.id, pg_temp.pid('user:'||(((c.n * 7 + k) % ${USERS}) + 1)),
       c.total, c.total, c.last_at - interval '60 days'
FROM perf_conv c CROSS JOIN generate_series(0, ${GROUP_MEMBERS - 1}) k WHERE c.kind = 'GROUP';

INSERT INTO "ChatMessage"(id, "conversationID", height, "senderID", type, content, "createdAt")
SELECT gen_random_uuid()::text, c.id, h,
       CASE
         WHEN c.kind = 'DIRECT' AND h % 3 = 0 THEN $2
         WHEN c.kind = 'DIRECT' THEN pg_temp.pid('user:'||c.n)
         WHEN h % 9 = 0 THEN $2
         ELSE pg_temp.pid('user:'||(((c.n * 7 + (h % ${GROUP_MEMBERS})) % ${USERS}) + 1))
       END,
       'text',
       jsonb_build_object('text', pg_temp.phrase(h + c.n)),
       c.last_at - ((c.total - h) * interval '3 minutes')
FROM perf_conv c CROSS JOIN LATERAL generate_series(1, c.total) h;

INSERT INTO "NoteGroup"(id, "ownerID", name, "sortOrder", "updatedAt")
SELECT pg_temp.pid('notegroup:'||g), $2, '压测分组 ' || (g + 1), g, now()
FROM generate_series(0, 7) g;

INSERT INTO "Note"(id, "ownerID", title, content, "contentJson", sections, status, pinned,
                   "mediaCount", "imageCount", "createdAt", "updatedAt")
SELECT pg_temp.pid('note:'||n), $2,
       '压测笔记 ' || n || ' · ' || pg_temp.phrase(n),
       body.txt, body.blocks,
       jsonb_build_object('text', jsonb_build_object('content', body.txt, 'contentJson', body.blocks)),
       'ACTIVE', n <= 3,
       CASE WHEN n % 10 < 7 THEN 1 ELSE 0 END, CASE WHEN n % 10 < 7 THEN 1 ELSE 0 END,
       now() - (n * interval '3 hours'), now() - (n * interval '3 hours')
FROM generate_series(1, ${NOTES}) n
CROSS JOIN LATERAL (
  SELECT t.txt, jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid()::text, 'type', 'paragraph',
    'props', jsonb_build_object('textColor', 'default', 'textAlignment', 'left', 'backgroundColor', 'default'),
    'content', jsonb_build_array(jsonb_build_object('text', t.txt, 'type', 'text', 'styles', '{}'::jsonb)),
    'children', '[]'::jsonb)) AS blocks
  FROM (SELECT pg_temp.phrase(n) || '。' || pg_temp.phrase(n + 9) || ' ' || pg_temp.phrase(n + 12) AS txt) t
) body;

INSERT INTO "NoteMedia"(id, "noteID", type, "objectKey", url, "mimeType", size, width, height, "sortOrder")
SELECT pg_temp.pid('notemedia:'||n), pg_temp.pid('note:'||n), 'IMAGE',
       'notes/' || $2 || '/perf-cover-' || lpad((n % ${COVERS})::text, 3, '0') || '.jpg',
       $3 || '/notes/' || $2 || '/perf-cover-' || lpad((n % ${COVERS})::text, 3, '0') || '.jpg',
       'image/jpeg', $4::int, 2048, 1536, 0
FROM generate_series(1, ${NOTES}) n WHERE n % 10 < 7;

UPDATE "Note" SET "coverMediaID" = pg_temp.pid('notemedia:'||n)
FROM generate_series(1, ${NOTES}) n
WHERE "Note".id = pg_temp.pid('note:'||n) AND n % 10 < 7;

INSERT INTO "NoteGroupMembership"(id, "noteID", "groupID")
SELECT gen_random_uuid()::text, pg_temp.pid('note:'||n), pg_temp.pid('notegroup:'||(n % 8))
FROM generate_series(1, ${NOTES}) n WHERE n % 3 = 0;
`;

/** 多语句脚本不能带参数：按分号拆开逐条执行，每条只传它引用到的那几个参数。 */
async function runStatements(client, script, all) {
  for (const statement of script.split(/;\s*\n/)) {
    const sql = statement.replace(/^\s*--.*$/gm, '').trim();
    if (!sql) continue;
    const used = [...new Set([...sql.matchAll(/\$(\d)/g)].map((m) => Number(m[1])))].sort();
    // 参数出现在 SELECT 列表里时 Postgres 推不出类型，统一显式标成 text（$4 自带 ::int）。
    let rewritten = sql.replace(/\$([123])\b/g, '$$$1::text');
    used.forEach((original, index) => {
      rewritten = rewritten.replaceAll(`$${original}`, `$__${index + 1}`);
    });
    await client.query(
      rewritten.replaceAll('$__', '$'),
      used.map((original) => all[original - 1]),
    );
  }
}

async function ensureTarget(client) {
  const found = await client.query(
    'select id, "passwordHash" from "User" where "accountId" = $1',
    [TARGET_ACCOUNT],
  );
  if (found.rowCount === 1) return { ...found.rows[0], created: false };
  const password = process.env.PERF_TARGET_PASSWORD;
  if (!password) throw new Error(`找不到目标账号 ${TARGET_ACCOUNT}，也没给 PERF_TARGET_PASSWORD 来新建。`);
  const passwordHash = await beRequire('argon2').hash(password);
  const created = await client.query(
    `insert into "User"(id, "accountId", "inviteCode", "passwordHash", nickname, "updatedAt")
     values (pg_temp.pid('target:' || $1), $1, upper($1), $2, '压测主号', now())
     returning id, "passwordHash"`,
    [TARGET_ACCOUNT, passwordHash],
  );
  return { ...created.rows[0], created: true };
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

    if (flag('--clean')) {
      const target = await client.query(
        `select id, id = pg_temp.pid('target:' || $1) as ours from "User" where "accountId" = $1`,
        [TARGET_ACCOUNT],
      );
      await client.query('BEGIN');
      await runStatements(client, CLEAN_SQL, []);
      // 只删脚本自己建的目标账号；原本就有的账号原样留下。
      if (target.rows[0]?.ours) {
        await client.query('delete from "User" where id = $1', [target.rows[0].id]);
      }
      await client.query('COMMIT');
      if (target.rowCount === 1 && !flag('--skip-media')) {
        const keys = mediaKeys(target.rows[0].id);
        await storage(env).remove([...keys.covers, ...keys.avatars]);
      }
      console.log(JSON.stringify({ cleaned: true, database: db, target: TARGET_ACCOUNT }));
      return;
    }

    const target = await ensureTarget(client);
    let coverBytes = 450000;
    if (!flag('--skip-media')) {
      const dir = option('--media-dir');
      if (!dir) throw new Error('需要 --media-dir（含 cover.jpg 和 avatar.jpg），或加 --skip-media。');
      const cover = fs.readFileSync(path.join(dir, 'cover.jpg'));
      const avatar = fs.readFileSync(path.join(dir, 'avatar.jpg'));
      coverBytes = cover.length;
      const keys = mediaKeys(target.id);
      await storage(env).put([
        ...keys.covers.map((Key) => ({ Key, Body: cover })),
        ...keys.avatars.map((Key) => ({ Key, Body: avatar })),
      ]);
      console.log(`媒体已上传：${keys.covers.length} 张封面（各 ${cover.length} 字节）、${keys.avatars.length} 个头像（各 ${avatar.length} 字节）`);
    }

    await client.query('BEGIN');
    const params = [target.passwordHash, target.id, mediaBase(env), coverBytes];
    await runStatements(client, CLEAN_SQL, params);
    await runStatements(client, SEED_SQL, params);
    await client.query('COMMIT');

    const summary = await client.query(
      `select
         (select count(*) from "ChatMember" where "userID" = $1 and "leftAt" is null) as conversations,
         (select count(*) from "ChatMessage" m join "ChatMember" cm
            on cm."conversationID" = m."conversationID" and cm."userID" = $1) as messages,
         (select count(*) from "Note" where "ownerID" = $1 and status = 'ACTIVE') as notes,
         (select count(*) from "Friend" where "userID" = $1 and state = 'ACCEPTED') as friends,
         (select count(*) from "ChatConversation" c where c."nextHeight" <
            (select max(height) from "ChatMessage" m where m."conversationID" = c.id)) as drifted`,
      [target.id],
    );
    console.log(JSON.stringify({
      database: db, target: TARGET_ACCOUNT, targetCreated: target.created, ...summary.rows[0],
    }));
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
