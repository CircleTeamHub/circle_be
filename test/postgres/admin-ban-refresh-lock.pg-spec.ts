import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Client } from 'pg';
import { AdminUserAuditService } from 'src/admin-user/admin-user-audit.service';
import { AdminUserService } from 'src/admin-user/admin-user.service';
import { AuthService } from 'src/auth/auth.service';
import { DeviceTrustService } from 'src/auth/device-trust.service';
import { RefreshTokenService } from 'src/auth/refresh-token.service';
import type { PrismaClient } from 'src/generated/prisma';
import { backendPid, waitUntilBlockedBy } from './circle-tx-harness';
import { describePostgres } from './pg-test-db';
import {
  openPrismaSchema,
  type PrismaHandle,
  type PrismaSchemaDb,
} from './prisma-schema-db';

/**
 * 管理台封禁与并发续签的竞态(真库、真 AuthService.refresh、真 AdminUserService)。
 *
 * 续签在账号锁(auth_session:<userId>)里先轮换出新会话、再读 status。封禁原来不拿
 * 这把锁:续签读到 ACTIVE 之后、提交之前封禁提交,封禁的 updateMany 看不到那条还没
 * 提交的新会话,它就躲过吊销 —— 封禁期间被 status 挡住,解封后又能用。
 *
 * 用例把续签卡在「已读到 ACTIVE、还没提交」的位置:另一个连接以 SHARE 模式锁住
 * TrustedDevice,续签读完 status 后的第一条写(设备信任 touch)就停在那里,账号锁
 * 仍握在手里。此时发起封禁,它必须排在账号锁后面;放开之后续签先提交,封禁再把
 * 那条新会话一并吊销。
 */
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const PHONE = 'a'.repeat(64);

function services(prisma: PrismaClient) {
  const config = new ConfigService({ JWT_EXPIRES_IN: '1h' });
  const revocation = {
    revokeSession: jest.fn(async () => true),
    revokeUser: jest.fn(async () => undefined),
    revokeScope: jest.fn(async () => true),
  };
  const realtime = {
    broadcast: jest.fn(),
    invalidateUserProfileSummaryCache: jest.fn(async () => undefined),
    broadcastUserProfileSummary: jest.fn(async () => undefined),
  };
  const refreshTokens = new RefreshTokenService(
    prisma as never,
    config,
    revocation as never,
  );
  const auth = new AuthService(
    prisma as never,
    refreshTokens,
    new JwtService({
      secret: 'ban-refresh-lock',
      signOptions: { expiresIn: 3600 },
    }),
    {} as never,
    {} as never,
    config,
    {} as never,
    {} as never,
    new DeviceTrustService(prisma as never, realtime as never),
  );
  const admin = new AdminUserService(
    prisma as never,
    new AdminUserAuditService(prisma as never),
    {
      revokeUserAt: jest.fn(async () => true),
      revocationExpiresAt: jest.fn(
        (revokedAt: number) => new Date(revokedAt + 86_400_000),
      ),
    } as never,
    realtime as never,
    { getDisplayIconsForUser: jest.fn(async () => []) } as never,
  );
  return { auth, admin };
}

describePostgres('admin ban vs. concurrent refresh (PostgreSQL)', () => {
  let env: PrismaSchemaDb;
  let main: PrismaHandle;
  let svc: ReturnType<typeof services>;
  const clients: Client[] = [];

  const rawClient = async (): Promise<Client> => {
    const client = new Client({
      connectionString: process.env.POSTGRES_TEST_DATABASE_URL,
    });
    await client.connect();
    await client.query(`SET search_path TO "${env.schema}", public`);
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    env = await openPrismaSchema('ban_refresh');
    main = env.client(6);
    svc = services(main.prisma);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end().catch(() => {})));
    await env?.close();
  });

  const seedUser = async (role = 'USER') => {
    const id = randomUUID();
    const accountId = `acc_${id.slice(0, 8)}`;
    await env.db.query(
      `INSERT INTO "AccountIdentifier" (value, "updatedAt") VALUES ($1, now())`,
      [accountId],
    );
    await env.db.query(
      `INSERT INTO "User" (id, "accountId", "inviteCode", "passwordHash", nickname, "updatedAt", role, status, "lastOnline")
       VALUES ($1, $2, $3, 'x', 'n', now(), $4, 'ACTIVE', now())`,
      [id, accountId, `INV${id.slice(0, 8)}`, role],
    );
    return { id, accountId };
  };

  const seedSession = async (userId: string) => {
    const raw = randomBytes(64).toString('hex');
    await env.db.query(
      `INSERT INTO "RefreshToken" (id, "userId", token, audience, "deviceKey", "deviceName", "expiredAt")
       VALUES ($1, $2, $3, 'APP', $4, 'Owner iPhone', now() + interval '1 day')`,
      [randomUUID(), userId, sha256(raw), PHONE],
    );
    // 已受信任的设备:续签读完 status 后第一条写就是 touch 这一行。
    await env.db.query(
      `INSERT INTO "TrustedDevice" (id, "userId", "deviceKey", "deviceName", "lastSeenAt")
       VALUES ($1, $2, $3, 'Owner iPhone', now())`,
      [randomUUID(), userId, PHONE],
    );
    return raw;
  };

  it('makes a ban wait for an in-flight refresh and revokes the session it created', async () => {
    const actor = await seedUser('ADMIN');
    const target = await seedUser();
    const raw = await seedSession(target.id);
    const observer = await rawClient();
    const gate = await rawClient();

    await gate.query('BEGIN');
    await gate.query('LOCK TABLE "TrustedDevice" IN SHARE MODE');
    const refreshing = svc.auth.refresh(raw);
    // 续签已轮换出新会话、读到 ACTIVE,停在设备信任的写上,账号锁还握着。
    const [refreshPid] = await waitUntilBlockedBy(
      observer,
      await backendPid(gate),
    );

    const banning = svc.admin.updateStatus(
      { userId: actor.id, accountId: actor.accountId },
      target.id,
      { status: 'BANNED', reason: 'race regression' } as never,
    );
    // 封禁排在续签的账号锁后面(修复前它不等,直接提交)。
    await waitUntilBlockedBy(observer, refreshPid);

    await gate.query('COMMIT');
    const tokens = await refreshing;
    expect(tokens).toBeDefined();
    await banning;

    const { rows } = await env.db.query<{ total: number; live: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE "revokedAt" IS NULL)::int AS live
         FROM "RefreshToken" WHERE "userId" = $1`,
      [target.id],
    );
    // 原会话被续签轮换掉,新会话被封禁吊销:一条都不剩。
    expect(rows[0]).toEqual({ total: 2, live: 0 });
    const user = await env.db.query<{ status: string }>(
      `SELECT status FROM "User" WHERE id = $1`,
      [target.id],
    );
    expect(user.rows[0].status).toBe('BANNED');
  }, 30_000);

  it('rejects a refresh that starts while a ban holds the account lock', async () => {
    const actor = await seedUser('ADMIN');
    const target = await seedUser();
    const raw = await seedSession(target.id);
    const observer = await rawClient();
    const gate = await rawClient();

    // 把封禁卡在吊销会话之后、提交之前:锁住 SessionRevocationOutbox 让 upsert 等着。
    await gate.query('BEGIN');
    await gate.query('LOCK TABLE "SessionRevocationOutbox" IN SHARE MODE');
    const banning = svc.admin.updateStatus(
      { userId: actor.id, accountId: actor.accountId },
      target.id,
      { status: 'BANNED', reason: 'race regression' } as never,
    );
    const [banPid] = await waitUntilBlockedBy(observer, await backendPid(gate));

    const refreshing = svc.auth.refresh(raw);
    await waitUntilBlockedBy(observer, banPid);
    await gate.query('COMMIT');
    await banning;

    await expect(refreshing).rejects.toBeDefined();
    const { rows } = await env.db.query<{ live: number }>(
      `SELECT count(*) FILTER (WHERE "revokedAt" IS NULL)::int AS live
         FROM "RefreshToken" WHERE "userId" = $1`,
      [target.id],
    );
    expect(rows[0].live).toBe(0);
  }, 30_000);

  it('keeps waiting for the account lock past the default 5s transaction timeout', async () => {
    const actor = await seedUser('ADMIN');
    const target = await seedUser();
    const observer = await rawClient();
    const holder = await rawClient();

    // 一个慢的登录 / 续签握着账号锁超过 5 秒(Prisma 交互事务的默认超时)。
    await holder.query('BEGIN');
    await holder.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`auth_session:${target.id}`],
    );
    const banning = svc.admin.updateStatus(
      { userId: actor.id, accountId: actor.accountId },
      target.id,
      { status: 'BANNED', reason: 'slow lock holder' } as never,
    );
    await waitUntilBlockedBy(observer, await backendPid(holder));
    await new Promise((done) => setTimeout(done, 6_000));
    await holder.query('COMMIT');

    await expect(banning).resolves.toMatchObject({ status: 'BANNED' });
    const user = await env.db.query<{ status: string }>(
      `SELECT status FROM "User" WHERE id = $1`,
      [target.id],
    );
    expect(user.rows[0].status).toBe('BANNED');
  }, 30_000);

  it('does not hold the global admin lock while waiting for an account lock', async () => {
    const actor = await seedUser('ADMIN');
    const slow = await seedUser();
    const other = await seedUser();
    const observer = await rawClient();
    const holder = await rawClient();

    await holder.query('BEGIN');
    await holder.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`auth_session:${slow.id}`],
    );
    const stuck = svc.admin.updateStatus(
      { userId: actor.id, accountId: actor.accountId },
      slow.id,
      { status: 'BANNED', reason: 'slow lock holder' } as never,
    );
    await waitUntilBlockedBy(observer, await backendPid(holder));

    // 等账号锁的那笔没占着全局锁:另一个用户的封禁照常完成,不用排队。
    await expect(
      svc.admin.updateStatus(
        { userId: actor.id, accountId: actor.accountId },
        other.id,
        { status: 'BANNED', reason: 'independent ban' } as never,
      ),
    ).resolves.toMatchObject({ status: 'BANNED' });

    await holder.query('COMMIT');
    await expect(stuck).resolves.toMatchObject({ status: 'BANNED' });
  }, 30_000);
});
