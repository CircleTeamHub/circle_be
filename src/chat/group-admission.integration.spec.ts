import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from 'src/generated/prisma';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { GroupAdmissionService } from './group-admission.service';

// Opt-in; isolated schema only. Never migrates or seeds the application's schema.
const run = process.env.GROUP_ADMISSION_TEST_DATABASE_URL
  ? describe
  : describe.skip;
run('Group admission PostgreSQL transactions', () => {
  const schema = `group_admission_test_${randomUUID().replace(/-/g, '')}`;
  let pool: Pool;
  let db: PrismaClient;
  let admin: Pool;
  let service: GroupAdmissionService;
  const owner = randomUUID();
  const guest = randomUUID();
  const second = randomUUID();
  const group = randomUUID();
  beforeAll(async () => {
    admin = new Pool({
      connectionString: process.env.GROUP_ADMISSION_TEST_DATABASE_URL,
    });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: process.env.GROUP_ADMISSION_TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    const sql = readFileSync(
      process.env.GROUP_ADMISSION_TEST_SCHEMA_SQL!,
      'utf8',
    ).replace('CREATE SCHEMA IF NOT EXISTS "public";', '');
    await pool.query(sql);
    if (process.env.GROUP_ADMISSION_TEST_MIGRATION_SQL) {
      // This is an explicit opt-in test fixture path, never a request parameter.
      await pool.query(
        readFileSync(process.env.GROUP_ADMISSION_TEST_MIGRATION_SQL, 'utf8'),
      );
    }
    // Schema diff cannot express partial uniqueness/checks; exercise migration constraints too.
    await pool.query(
      'CREATE UNIQUE INDEX "test_active_admission" ON "GroupAdmission"("conversationID","applicantID") WHERE "status" IN (\'INVITED\',\'PENDING\')',
    );
    db = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    await db.accountIdentifier.createMany({
      data: [owner, guest, second].map((value) => ({ value })),
    });
    await db.user.createMany({
      data: [owner, guest, second].map((id) => ({
        id,
        accountId: id,
        inviteCode: id,
        passwordHash: 'test-only',
        nickname: id,
      })),
    });
    await db.friend.createMany({
      data: [guest, second].map((friendID) => ({
        userID: owner,
        friendID,
        state: 'ACCEPTED',
      })),
    });
    await db.chatConversation.create({
      data: {
        id: group,
        type: 'GROUP',
        name: 'test',
        ownerID: owner,
        members: { create: { userID: owner } },
      },
    });
    service = new GroupAdmissionService(
      db as any,
      { getGroupConversationForMember: async () => ({ id: group }) } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    // Delivery has independent tests; leave durable jobs in the DB for assertions.
    jest.spyOn(service, 'flush').mockResolvedValue(undefined);
  }, 30000);
  afterAll(async () => {
    if (db) await db.$disconnect();
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
  it('the applied migration matches the Prisma schema without referential-action drift', () => {
    const url = new URL(process.env.GROUP_ADMISSION_TEST_DATABASE_URL!);
    url.searchParams.set('schema', schema);
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      {
        env: { ...process.env, DATABASE_URL: url.toString() },
        encoding: 'utf8',
      },
    );
    expect({ code: result.status, output: result.stdout }).toEqual({
      code: 0,
      output: expect.any(String),
    });
  });
  it('serializes manager invites and joins exactly once only after acceptance', async () => {
    await Promise.all([
      service.invite(owner, group, [guest]),
      service.invite(owner, group, [guest]),
    ]);
    expect(await db.groupAdmission.count()).toBe(1);
    expect(await db.groupAdmissionDelivery.count()).toBe(1);
    expect(await db.chatMember.count({ where: { userID: guest } })).toBe(0);
    const a = await db.groupAdmission.findFirstOrThrow();
    await expect(service.act(owner, a.id, 'approve')).rejects.toThrow();
    await service.act(guest, a.id, 'accept');
    expect(await db.chatMember.count({ where: { userID: guest } })).toBe(1);
    await Promise.all([
      service.act(owner, a.id, 'approve'),
      service.act(owner, a.id, 'approve'),
    ]);
    expect(
      await db.chatMember.count({ where: { userID: guest, leftAt: null } }),
    ).toBe(1);
    expect(
      await db.groupAdmissionDelivery.count({ where: { event: 'JOINED' } }),
    ).toBe(1);
  });
  it('rolls back an invalid QR acceptance and leaves no pending record or member', async () => {
    const token = randomUUID();
    await db.qrToken.create({
      data: {
        token,
        type: 'GROUP',
        targetID: group,
        issuerID: owner,
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await expect(service.acceptQr(second, token)).rejects.toThrow();
    expect(
      await db.groupAdmission.count({ where: { applicantID: second } }),
    ).toBe(0);
    expect(await db.chatMember.count({ where: { userID: second } })).toBe(0);
  });
  it('serializes final-capacity approvals so only one applicant gets the remaining seat', async () => {
    await db.chatMember.update({
      where: {
        conversationID_userID: { conversationID: group, userID: guest },
      },
      data: { leftAt: new Date() },
    });
    const filler = Array.from({ length: 198 }, () => randomUUID());
    await db.chatMember.createMany({
      data: filler.map((userID) => ({ conversationID: group, userID })),
    });
    await Promise.all([
      service.apply(guest, group, ''),
      service.apply(second, group, ''),
    ]);
    const records = await db.groupAdmission.findMany({
      where: { status: 'PENDING' },
    });
    const results = await Promise.allSettled(
      records.map((a) => service.act(owner, a.id, 'approve')),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      await db.chatMember.count({
        where: { conversationID: group, leftAt: null },
      }),
    ).toBe(200);
  });
  it('hydrates the inbox in batches and only exposes applicant/inviter or current-manager records', async () => {
    const record = await db.groupAdmission.findFirstOrThrow({
      where: { status: 'PENDING' },
    });
    await db.notification.createMany({
      data: [
        {
          fromUserID: second,
          toUserID: owner,
          type: 'GROUP_ADMISSION',
          fromGroupAdmissionID: record.id,
        },
        {
          fromUserID: second,
          toUserID: owner,
          type: 'GROUP_ADMISSION',
          fromGroupAdmissionID: record.id,
        },
        {
          fromUserID: second,
          toUserID: owner,
          type: 'GROUP_ADMISSION',
          fromGroupAdmissionID: record.id,
          read: true,
        },
        {
          fromUserID: second,
          toUserID: owner,
          type: 'GROUP_ADMISSION',
          fromGroupAdmissionID: record.id,
          deleted: true,
        },
        {
          fromUserID: second,
          toUserID: guest,
          type: 'GROUP_ADMISSION',
          fromGroupAdmissionID: record.id,
        },
      ],
    });
    const ownerPage = await service.list(owner);
    expect(ownerPage.items.length).toBeGreaterThan(0);
    expect(
      ownerPage.items.every(
        (item) => item.group.id === group && item.group.memberCount === 200,
      ),
    ).toBe(true);
    expect(
      ownerPage.items.find((item) => item.id === record.id)?.unreadCount,
    ).toBe(2);
    await db.notification.updateMany({
      where: { toUserID: owner },
      data: { read: true },
    });
    expect(
      (await service.list(owner)).items.find((item) => item.id === record.id)
        ?.unreadCount,
    ).toBe(0);
    const guestPage = await service.list(second);
    expect(guestPage.items.every((item) => item.unreadCount === 0)).toBe(true);
    expect(guestPage.items.every((item) => item.applicantId === second)).toBe(
      true,
    );
  });
});
