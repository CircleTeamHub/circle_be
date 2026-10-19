import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';
import { AdminAccessService } from '../src/admin-access/admin-access.service';
async function main() {
  const envLine = readFileSync('.env.development', 'utf8')
    .split('\n')
    .find((line) => line.startsWith('DATABASE_URL='));
  const connectionString =
    process.env.DATABASE_URL ||
    envLine?.slice('DATABASE_URL='.length).trim().replace(/^"|"$/g, '');
  assert.ok(connectionString);
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(
      new URL(connectionString).hostname,
    ),
    'Only a local test database is allowed',
  );
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  const rollback = new Error('rollback administrator integration fixtures');
  try {
    await assert.rejects(
      prisma.$transaction(
        async (tx) => {
          const actor = await tx.user.findFirst({
            where: {
              role: 'ADMIN',
              status: 'ACTIVE',
              adminAccess: { role: 'SUPER_ADMIN' },
            },
            select: { id: true },
          });
          assert.ok(actor, 'A local super administrator fixture is required');
          const service = new AdminAccessService({
            $transaction: async (fn: any) => fn(tx),
            user: tx.user,
            accountIdentifier: tx.accountIdentifier,
          } as any);
          const accountId = 'qa_' + randomBytes(6).toString('hex');
          const created = await service.create(actor.id, {
            nickname: '管理员回归测试',
            accountId,
            password: 'A1' + randomBytes(16).toString('hex'),
            role: 'SUPPORT',
          });
          assert.equal(created.accountId, accountId);
          assert.deepEqual(await service.availability({ accountId }), {
            available: false,
          });
          assert.deepEqual(
            await service.availability({
              accountId,
              excludeUserId: created.id,
            }),
            { available: true },
          );
          assert.deepEqual(
            await service.availability({ accountId: accountId + '_free' }),
            { available: true },
          );
          await assert.rejects(
            service.create(actor.id, {
              nickname: '重复账号',
              accountId,
              password: 'A1' + randomBytes(16).toString('hex'),
              role: 'SUPPORT',
            }),
            { status: 409 },
          );
          const access = await tx.adminAccess.findUniqueOrThrow({
            where: { userID: created.id },
          });
          const changed = await service.update(actor.id, created.id, {
            nickname: '已编辑管理员',
            accountId: accountId + '_new',
            role: 'MODERATOR',
            reason: '本地自动回归测试',
            version: access.version,
          });
          const updated = await tx.user.findUniqueOrThrow({
            where: { id: created.id },
          });
          assert.equal(updated.nickname, '已编辑管理员');
          assert.equal(updated.accountId, accountId + '_new');
          assert.equal(updated.email, null);
          await assert.rejects(
            service.update(actor.id, created.id, {
              role: 'SUPPORT',
              reason: '过期版本测试',
              version: access.version,
            }),
            { status: 409 },
          );
          await assert.rejects(
            service.remove(actor.id, actor.id, {
              version: 0,
              reason: '禁止删除自己',
            }),
            { status: 400 },
          );
          await service.remove(actor.id, created.id, {
            version: changed.version,
            reason: '删除测试账号',
          });
          assert.equal(
            (await tx.user.findUniqueOrThrow({ where: { id: created.id } }))
              .status,
            'DELETED',
          );
          assert.equal(
            await tx.adminAuditLog.count({ where: { entityID: created.id } }),
            3,
          );
          throw rollback;
        },
        { timeout: 30000 },
      ),
      (error) => error === rollback,
    );
    console.log(
      'PASS: local PostgreSQL create, collision, edit, stale version and delete; all fixtures rolled back',
    );
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.name : 'Administrator integration failed',
  );
  process.exitCode = 1;
});
