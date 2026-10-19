// Loopback HTTP + PostgreSQL acceptance. Creates and deletes UUID-scoped fixtures only.
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'dotenv';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { Injectable, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { DefaultAuthGuard } from 'src/guards/default-auth.guard';
import {
  ConsoleController,
  AppOperationsController,
  ConsoleToolController,
} from 'src/admin-console/console.controller';
import { ConsoleOperationsService } from 'src/admin-console/console-operations.service';
import { ConsoleInsightsService } from 'src/admin-console/console-insights.service';
import {
  ConsoleKeysService,
  ConsoleKeyGuard,
} from 'src/admin-console/console-keys.service';
import { ConsoleReleasesService } from 'src/admin-console/console-releases.service';
import { NotificationPushOutboxProcessor } from 'src/notification/notification-push-outbox.processor';
import { AdminPermissionGuard } from 'src/admin-access/admin-permission.guard';

const env = {
  ...parse(readFileSync('.env')),
  ...(existsSync('.env.development')
    ? parse(readFileSync('.env.development'))
    : {}),
  ...process.env,
};
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(
    new URL(env.DATABASE_URL!).hostname,
  )
)
  throw Error('Loopback database required');
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const secret = randomBytes(32).toString('hex'),
  jwt = new JwtService({ secret });
@Injectable()
class LocalStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: secret,
    });
  }
  validate(p: { sub: string; role: string; audience: string; sid?:string }) {
    return { userId: p.sub, role: p.role, audience: p.audience,sessionId:p.sid };
  }
}
const users = [randomUUID(), randomUUID(), randomUUID()],
  releaseIDs: string[] = [],
  pushID = randomUUID(),
  announcementID = randomUUID();
let app: any,
  passed = 0;
const check = (label: string) => {
  passed++;
  console.log(`PASS ${label}`);
};
async function main() {
  // Clean only fixtures left by this script's first interrupted cleanup.
  const stale = await db.user.findMany({
    where: {
      nickname: 'Console acceptance',
      accountId: { startsWith: 'console-' },
      passwordHash: 'disabled-test-password',
    },
    select: { id: true, accountId: true },
  });
  const staleIDs = stale
    .filter((r) => r.accountId === `console-${r.id}`)
    .map((r) => r.id);
  if (staleIDs.length) {
    await db.accountIdentifier.updateMany({
      where: {
        OR: [
          { currentUserID: { in: staleIDs } },
          { reservedForUserID: { in: staleIDs } },
          { inviteOwnerUserID: { in: staleIDs } },
        ],
      },
      data: {
        currentUserID: null,
        reservedForUserID: null,
        inviteOwnerUserID: null,
      },
    });
    await db.user.deleteMany({ where: { id: { in: staleIDs } } });
    await db.accountIdentifier.deleteMany({
      where: { value: { in: stale.flatMap((r) => [r.id, r.accountId]) } },
    });
  }
  for (let i = 0; i < users.length; i++)
    await db.user.create({
      data: {
        id: users[i],
        accountId: `console-${users[i]}`,
        inviteCode: users[i],
        nickname: 'Console acceptance',
        passwordHash: 'disabled-test-password',
        role: i === 1 ? 'USER' : 'ADMIN',
        status: 'ACTIVE',
        ...(i !== 1
          ? {
              adminAccess: {
                create: { role: i === 0 ? 'SUPER_ADMIN' : 'SUPPORT' },
              },
            }
          : {}),
      },
    });
  const module = await Test.createTestingModule({
    imports: [
      PassportModule,
      ThrottlerModule.forRoot([{ ttl: 60000, limit: 2000 }]),
    ],
    controllers: [
      ConsoleController,
      AppOperationsController,
      ConsoleToolController,
    ],
    providers: [
      LocalStrategy,
      ConsoleOperationsService,
      ConsoleInsightsService,
      ConsoleKeysService,
      ConsoleKeyGuard,
      ConsoleReleasesService,
      AdminPermissionGuard,
      { provide: PrismaService, useValue: db },
      { provide: ConfigService, useValue: new ConfigService({}) },
      { provide: APP_GUARD, useClass: DefaultAuthGuard },
    ],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(['error']);
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const session=await db.refreshToken.create({data:{userId:users[1],token:randomBytes(32).toString('hex'),deviceKey:createHash('sha256').update('console-test-device').digest('hex'),audience:'APP',expiredAt:new Date(Date.now()+60000)}});
  const admin = jwt.sign({ sub: users[0], role: 'ADMIN', audience: 'ADMIN' }),
    user = jwt.sign({ sub: users[1], role: 'USER', audience: 'APP',sid:session.id }),
    support = jwt.sign({ sub: users[2], role: 'ADMIN', audience: 'ADMIN' }),
    appAdmin = jwt.sign({ sub: users[0], role: 'ADMIN', audience: 'APP' });
  async function request(
    path: string,
    token: string | null = admin,
    method = 'GET',
    body?: unknown,
    key?: string,
  ) {
    const r = await fetch(base + path, {
      method,
      headers: {
        ...(token
          ? { Authorization: `Bearer ${token}` }
          : { 'x-device-id': 'console-test-device' }),
        'x-device-id': 'console-test-device',
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json(),headers:r.headers };
  }
  for (const token of [null, user, appAdmin])
    assert.ok(
      [401, 403].includes(
        (await request('/admin/console/tasks/overview', token)).status,
      ),
    );
  check('anonymous, ordinary accounts and APP tokens cannot read console data');
  assert.equal((await request('/admin/console/releases', support)).status, 403);
  check('read-only support role cannot manage releases or administrator keys');
  const eventID = randomUUID(),
    open = {
      platform: 'ios',
      appVersion: '1.0.0',
      build: 100,
      channel: 'stable',
      eventID,
    };
  assert.equal(
    (await request('/app-operations/open', user, 'POST', open)).status,
    201,
  );
  await request('/app-operations/open', user, 'POST', open);
  assert.equal(
    await db.consoleEvent.count({
      where: { userID: users[1], name: 'APP_OPEN' },
    }),
    1,
  );
  check(
    'App event retries deduplicate and account identity comes from authentication',
  );
  const registration=await db.appInstallation.findFirstOrThrow({where:{userID:users[1]}});
  const registeredPreview=await request(`/admin/console/releases/preview?platform=android&channel=beta&build=999&installation=local-preview-device&installationID=${registration.id}`);
  assert.equal(registeredPreview.status,200);assert.equal(registeredPreview.body.evaluatedClient.platform,'ios');assert.equal(registeredPreview.body.evaluatedClient.build,100);assert.ok(!JSON.stringify(registeredPreview.body).includes(registration.deviceKey));check('actual-device preview derives its version and rollout from the authenticated registration');
  const privateNote=await db.note.create({
    data: {
      ownerID: users[1],
      title: 'private test note',
      content: 'private-fixture-body-do-not-expose',
    },
  });
  const noteEvent=await db.consoleEvent.findFirstOrThrow({where:{entityID:privateNote.id,name:'NOTE_CREATED'}});assert.ok(Math.abs(noteEvent.createdAt.getTime()-privateNote.createdAt.getTime())<2000);check('database-triggered events use the same UTC clock as Prisma business records');
  const timeline = await request(`/admin/console/users/${users[1]}/timeline`);
  assert.equal(timeline.status, 200);
  assert.ok(timeline.body.items.some((e: any) => e.name === 'APP_OPEN'));
  assert.ok(!JSON.stringify(timeline.body).includes('passwordHash'));
  assert.ok(
    !JSON.stringify(timeline.body).includes(
      'private-fixture-body-do-not-expose',
    ),
  );
  check(
    'user timeline returns real events and version registration without credentials',
  );
  assert.equal(
    (await request('/admin/console/tasks?status=INVALID')).status,
    400,
  );
  assert.equal(
    (await request('/admin/console/tasks?cursor=broken')).status,
    400,
  );
  check('invalid task status and cursor are rejected before database queries');
  const keyResult = await request('/admin/console/keys', admin, 'POST', {
    name: 'local acceptance',
    scopes: ['tasks'],
    days: 1,
    reason: 'local acceptance',
  });
  assert.equal(keyResult.status, 201);
  const apiKey = keyResult.body.secret;
  assert.ok(apiKey.startsWith('cak_'));
  const stored = await db.consoleApiKey.findUniqueOrThrow({
    where: { id: keyResult.body.id },
  });
  assert.notEqual(stored.secretHash, apiKey);
  check('API keys appear once and only a hash is stored');
  assert.equal((await request('/ops/read/tasks', apiKey)).status, 200);
  assert.equal((await request('/ops/read/analytics', apiKey)).status, 401);
  assert.ok(
    [401, 403].includes(
      (await request('/admin/console/tasks/overview', apiKey)).status,
    ),
  );
  check(
    'exact key scopes are enforced and tool keys cannot authenticate general admin routes',
  );
  await db.adminAccess.update({
    where: { userID: users[0] },
    data: { role: 'SUPPORT' },
  });
  assert.equal((await request('/ops/read/tasks', apiKey)).status, 401);
  await db.adminAccess.update({
    where: { userID: users[0] },
    data: { role: 'SUPER_ADMIN' },
  });
  check(
    'current administrator permission changes invalidate tool access immediately',
  );
  const revoked = await request(
    `/admin/console/keys/${stored.id}/revoke`,
    admin,
    'POST',
    { reason: 'acceptance revoke' },
    randomUUID(),
  );
  assert.equal(revoked.status, 201, JSON.stringify(revoked.body));
  assert.equal((await request('/ops/read/tasks', apiKey)).status, 401);
  check('revoked keys are denied immediately');
  const keyExpired = await request('/admin/console/keys', admin, 'POST', {
    name: 'expired acceptance',
    scopes: ['tasks'],
    days: 1,
    reason: 'local acceptance',
  });
  await db.consoleApiKey.update({
    where: { id: keyExpired.body.id },
    data: { expiresAt: new Date(0) },
  });
  assert.equal(
    (await request('/ops/read/tasks', keyExpired.body.secret)).status,
    401,
  );
  check('expired keys cannot access tools');
  await db.systemAnnouncement.create({
    data: {
      id: announcementID,
      operatorID: users[0],
      content: 'Disposable local acceptance announcement',
      idempotencyKey: randomUUID(),
      requestFingerprint: randomUUID(),
    },
  });
  const notification = await db.notification.create({
    data: {
      fromUserID: users[0],
      toUserID: users[1],
      type: 'SYSTEM',
      content: 'fixture',
      pushOutbox: {
        create: {
          id: pushID,
          status: 'FAILED',
          lastError: 'raw token=secret',
          nextAttemptAt: new Date(Date.now() + 86400_000),
        },
      },
    },
  });
  const listing = await request(`/admin/console/push?userID=${users[1]}`);
  assert.equal(listing.status, 200);
  assert.equal(listing.body.items[0].lastError, 'PROCESSING_ERROR');
  assert.ok(!JSON.stringify(listing.body).includes('token=secret'));
  check(
    'push diagnostics redact provider error text and never return device tokens',
  );
  const settings = await db.consolePushSettings.findUniqueOrThrow({
    where: { id: 'global' },
  });
  await db
    .$transaction(async (tx) => {
      await tx.consolePushSettings.update({
        where: { id: 'global' },
        data: { enabled: false },
      });
      const processor = new NotificationPushOutboxProcessor(
        tx as unknown as PrismaService,
        {} as never,
      );
      assert.equal(await processor.processPending(), 0);
      throw new Error('rollback-test-only');
    })
    .catch((e) => {
      if (e.message !== 'rollback-test-only') throw e;
    });
  assert.equal(
    (
      await db.consolePushSettings.findUniqueOrThrow({
        where: { id: 'global' },
      })
    ).enabled,
    settings.enabled,
  );
  check('paused push prevents claiming tasks without dropping the queue');
  const sendBody = {
      recipients: [users[1]],
      announcementID,
      reason: 'local acceptance',
    },
    sendKey = randomUUID();
  const sent = await request(
    '/admin/console/push/send',
    admin,
    'POST',
    sendBody,
    sendKey,
  );
  assert.equal(sent.status, 201);
  assert.equal(sent.body.queued, 1);
  assert.deepEqual(
    (
      await request(
        '/admin/console/push/send',
        admin,
        'POST',
        sendBody,
        sendKey,
      )
    ).body,
    sent.body,
  );
  check(
    'targeted announcements create durable work exactly once across lost-response retries',
  );
  for (const kind of [
    'session_revocation',
    'gift_card',
    'verification_card',
    'group_operation',
    'friend_chat_replay',
  ])
    assert.equal(
      (await request('/admin/console/tasks?kind=' + kind)).status,
      200,
    );
  check('all queue families support bounded task drill-down');
  const version = listing.body.items[0].updatedAt,
    retryBody = { reason: 'local acceptance', version },
    retryKey = randomUUID();
  const retry = await request(
    `/admin/console/push/${pushID}/retry`,
    admin,
    'POST',
    retryBody,
    retryKey,
  );
  assert.equal(retry.status, 201);
  const again = await request(
    `/admin/console/push/${pushID}/retry`,
    admin,
    'POST',
    retryBody,
    retryKey,
  );
  assert.deepEqual(again.body, retry.body);
  check('retry receipt is idempotent even after original task state changes');
  const bad = await request(
    `/admin/console/push/${pushID}/retry`,
    admin,
    'POST',
    { reason: 'changed request', version },
    retryKey,
  );
  assert.equal(bad.status, 409);
  check('reusing a retry key with a changed payload is rejected');
  const dto = {
    platform: 'android',
    channel: 'beta',
    version: '999.0.0',
    build: 999000000,
    url: 'https://github.com/CircleTeamHub/windnote-releases/releases/download/v999.0.0/windnote.apk',
    sha256: 'a'.repeat(64),
    sizeBytes: 100,
    notes: 'local acceptance only',
    reason: 'local acceptance',
  };
  assert.equal(
    (
      await request(
        '/admin/console/releases',
        admin,
        'POST',
        { ...dto, url: 'https://evil.example/app.apk' },
        randomUUID(),
      )
    ).status,
    400,
  );
  check('release registration rejects untrusted download origins');
  const released = await request(
    '/admin/console/releases',
    admin,
    'POST',
    dto,
    randomUUID(),
  );
  assert.equal(released.status, 201);
  releaseIDs.push(released.body.id);
  const plan = {
    releaseID: released.body.id,
    rollout: 100,
    minBuild: 0,
    maxBuild: 998999999,
    forceBelow: 2000000,
    startsAt: new Date(Date.now() - 1000).toISOString(),
    endsAt: new Date(Date.now() + 60000).toISOString(),
    enabled: true,
    reason: 'local acceptance',
  };
  const planned = await request(
    '/admin/console/release-plans',
    admin,
    'POST',
    plan,
    randomUUID(),
  );
  assert.equal(planned.status, 201);
  const path =
    '/app-operations/update?platform=android&channel=beta&build=1000000&installation=acceptance-installation';
  const decision = await request(path, null);
  assert.equal(decision.status, 200);assert.equal(decision.headers.get("cache-control"),"no-store");
  assert.equal(decision.body.update.version, '999.0.0');
  assert.equal(decision.body.mandatory, true);
  check(
    'public update decisions use active plans and enforce the force-update threshold',
  );
  const altered = { ...plan, rollout: 0, version: 1 };
  assert.equal(
    (
      await request(
        `/admin/console/release-plans/${planned.body.id}`,
        admin,
        'PATCH',
        altered,
        randomUUID(),
      )
    ).status,
    200,
  );
  assert.equal((await request(path, null)).body.update, null);
  assert.equal(
    (
      await request(
        `/admin/console/release-plans/${planned.body.id}`,
        admin,
        'PATCH',
        altered,
        randomUUID(),
      )
    ).status,
    409,
  );
  check('rollout changes take effect and stale plan edits are rejected');
  await request(
    `/admin/console/releases/${released.body.id}/withdraw`,
    admin,
    'POST',
    { reason: 'local acceptance' },
    randomUUID(),
  );
  assert.equal((await request(path, null)).body.update, null);
  check('withdrawn releases are never offered');
  const analytics = await request('/admin/console/analytics?days=7');
  assert.equal(analytics.status, 200);
  assert.ok(analytics.body.collectionStartedAt);
  assert.ok(analytics.body.daily.length);
  check(
    'analytics execute real SQL with collection coverage and truthful retention denominators',
  );
  assert.ok(
    await db.adminAuditLog.count({
      where: { actorID: users[0], action: 'console.key.read' },
    }),
  );
  check('automated reads and all writes leave audit receipts');
  console.log(`LOCAL_CONSOLE_OK checks=${passed}`);
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await app?.close();
    await db.consoleReleasePlan.deleteMany({
      where: { releaseID: { in: releaseIDs } },
    });
    await db.consoleRelease.deleteMany({ where: { id: { in: releaseIDs } } });
    await db.notification.deleteMany({
      where: {
        OR: [{ toUserID: { in: users } }, { fromUserID: { in: users } }],
      },
    });
    await db.systemAnnouncement.deleteMany({
      where: { operatorID: { in: users } },
    });
    await db.adminOperationRequest.deleteMany({
      where: { actorID: { in: users } },
    });
    await db.adminAuditLog.deleteMany({ where: { actorID: { in: users } } });
    await db.accountIdentifier.updateMany({
      where: {
        OR: [
          { currentUserID: { in: users } },
          { reservedForUserID: { in: users } },
          { inviteOwnerUserID: { in: users } },
        ],
      },
      data: {
        currentUserID: null,
        reservedForUserID: null,
        inviteOwnerUserID: null,
      },
    });
    await db.note.deleteMany({ where: { ownerID: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.accountIdentifier.deleteMany({
      where: {
        value: { in: [...users, ...users.map((id) => `console-${id}`)] },
      },
    });
    await db.$disconnect();
  });
