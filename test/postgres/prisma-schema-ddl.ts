import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

let ddl: string | null = null;

/**
 * schema.prisma → 整套建表 SQL(`prisma migrate diff --from-empty --script`),每个进程
 * 只算一次。真 PrismaClient 跑在隔离 schema 上的几个 harness 共用这一份:表结构不手抄,
 * Prisma 模型改了这里跟着变。
 */
export function prismaSchemaDdl(): string {
  ddl ??= execFileSync(
    resolve(process.cwd(), 'node_modules/.bin/prisma'),
    [
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema',
      'prisma/schema.prisma',
      '--script',
    ],
    { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return ddl;
}
