import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * pg_advisory_xact_lock 返回 void。用 $queryRaw 执行时 Prisma 反序列化不了返回值，
 * 真库上直接 P2010 → 500（单测里 $queryRaw 被 mock 掉，发现不了）。
 * 加锁一律用 $executeRaw，或像 email-verification 那样显式 ::text 转换。
 */
describe('advisory lock raw queries', () => {
  it('never runs pg_advisory_xact_lock through $queryRaw without a cast', () => {
    const dir = __dirname;
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .flatMap((file) =>
        readFileSync(join(dir, file), 'utf8')
          .split('\n')
          .map((line, index) => ({ file, line, index }))
          .filter(
            ({ line }) =>
              /\$queryRaw`SELECT pg_advisory_xact_lock\(/.test(line) &&
              !/\)::\w+`/.test(line),
          )
          .map(({ file, index }) => `${file}:${index + 1}`),
      );
    expect(offenders).toEqual([]);
  });
});
