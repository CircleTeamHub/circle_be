#!/usr/bin/env node
/**
 * 后端压测的准备脚本（在 circle_be 容器里跑，依赖 seed-perf-data 建好的 600 个压测用户）。
 *
 * 1. 建一批只含压测用户的会话 —— 不带目标账号，免得真人手机被压测消息刷屏：
 *    300 个私聊（perf 2k-1 ↔ 2k）+ 40 个 30 人群。
 * 2. 给 600 个压测用户各签一个访问令牌，连同它能发言的会话写到标准输出（JSON）。
 *    令牌不带会话号：后端对「用户有效、没有对应会话记录」的令牌按有效处理。
 *
 * 标准输出只有那份 JSON，调用方直接重定向进被 git 忽略的本地文件；密钥不出容器。
 * `--clean` 删掉这些会话（消息随会话级联）。安全闸同 seed-perf-data。
 */
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

const BE_ROOT = process.env.CIRCLE_BE_ROOT || process.cwd();
const beRequire = createRequire(path.join(BE_ROOT, 'package.json'));
const { Client } = beRequire('pg');

const LOCAL_DB_NAME = 'circle_perf';
const REMOTE_DB_NAME = process.env.PERF_REMOTE_DATABASE || '';
// 默认规模与 seed-perf-data 建的 600 个压测用户对应；本机多实例压测要更多用户时用环境变量放大
// （用户行得先自己补进库，私聊数 = 用户数 / 2）。
const USERS = Number(process.env.PERF_LOAD_USERS || 600);
const DIRECTS = USERS / 2;
const GROUPS = Number(process.env.PERF_LOAD_GROUPS || 40);
const GROUP_MEMBERS = 30;
const TOKEN_TTL = process.env.PERF_TOKEN_TTL || '3h';

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

const SETUP_SQL = `
CREATE OR REPLACE FUNCTION pg_temp.pid(key text) RETURNS text AS $$
  SELECT substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12)
  FROM (SELECT md5('circle-perf:'||key) AS h) s
$$ LANGUAGE sql IMMUTABLE;
`;

const CLEAN_SQL = `
DELETE FROM "ChatConversation" WHERE id IN (
  SELECT pg_temp.pid('conv:load:d:'||k) FROM generate_series(1, ${DIRECTS}) k
  UNION ALL SELECT pg_temp.pid('conv:load:g:'||j) FROM generate_series(1, ${GROUPS}) j)
`;

const SEED_SQL = [
  `INSERT INTO "ChatConversation"(id, type, "directKey", "createdAt", "updatedAt")
   SELECT pg_temp.pid('conv:load:d:'||k), 'DIRECT',
          least(pg_temp.pid('user:'||(2*k-1)) COLLATE "C", pg_temp.pid('user:'||(2*k)) COLLATE "C") || ':' ||
          greatest(pg_temp.pid('user:'||(2*k-1)) COLLATE "C", pg_temp.pid('user:'||(2*k)) COLLATE "C"),
          now(), now()
   FROM generate_series(1, ${DIRECTS}) k`,
  `INSERT INTO "ChatConversation"(id, type, name, "ownerID", "createdAt", "updatedAt")
   SELECT pg_temp.pid('conv:load:g:'||j), 'GROUP', '压测负载群 ' || j,
          pg_temp.pid('user:'||(((j - 1) * 15) % ${USERS} + 1)), now(), now()
   FROM generate_series(1, ${GROUPS}) j`,
  `INSERT INTO "ChatMember"(id, "conversationID", "userID")
   SELECT gen_random_uuid()::text, pg_temp.pid('conv:load:d:'||k), pg_temp.pid('user:'||u)
   FROM generate_series(1, ${DIRECTS}) k CROSS JOIN LATERAL (VALUES (2*k-1), (2*k)) AS m(u)
   UNION ALL
   SELECT gen_random_uuid()::text, pg_temp.pid('conv:load:g:'||j),
          pg_temp.pid('user:'||((((j - 1) * 15 + i) % ${USERS}) + 1))
   FROM generate_series(1, ${GROUPS}) j CROSS JOIN generate_series(0, ${GROUP_MEMBERS - 1}) i`,
];

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
    await client.query('BEGIN');
    await client.query(CLEAN_SQL);
    if (!process.argv.includes('--clean')) {
      for (const sql of SEED_SQL) await client.query(sql);
    }
    await client.query('COMMIT');
    if (process.argv.includes('--clean')) {
      process.stderr.write('压测负载会话已删除\n');
      return;
    }

    const users = await client.query(
      `select u.id, u."accountId", u.role::text as role,
              coalesce(json_agg(json_build_object('id', c.id, 'kind', c.type::text) order by c.type, c.id)
                       filter (where c.id is not null), '[]') as conversations
       from "User" u
       left join "ChatMember" m on m."userID" = u.id and m."leftAt" is null
       left join "ChatConversation" c on c.id = m."conversationID"
         and c.id in (select pg_temp.pid('conv:load:d:'||k) from generate_series(1, ${DIRECTS}) k
                      union all select pg_temp.pid('conv:load:g:'||j) from generate_series(1, ${GROUPS}) j)
       where u."accountId" ~ '^perf[0-9]{4}$'
       group by u.id order by u."accountId"`,
    );
    if (users.rowCount !== USERS) throw new Error(`压测用户应有 ${USERS} 个，实际 ${users.rowCount} 个。`);
    if (!env.SECRET) throw new Error('环境里没有签名密钥。');
    const jwt = beRequire('jsonwebtoken');
    const accounts = users.rows.map((user) => ({
      alias: user.accountId,
      userId: user.id,
      accessToken: jwt.sign(
        { sub: user.id, accountId: user.accountId, role: user.role, aud: 'APP' },
        env.SECRET,
        { expiresIn: TOKEN_TTL },
      ),
      conversations: user.conversations,
    }));
    process.stdout.write(`${JSON.stringify(accounts)}\n`);
    process.stderr.write(`已签发 ${accounts.length} 个令牌（有效期 ${TOKEN_TTL}），会话 ${DIRECTS} 私聊 + ${GROUPS} 群\n`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
