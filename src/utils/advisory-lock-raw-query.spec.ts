import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * pg_advisory_xact_lock 返回 void。用 $queryRaw 执行时 Prisma 反序列化不了返回值，
 * 真库上直接 P2010（"Failed to deserialize column of type 'void'"）→ 500；单测里
 * $queryRaw 被 mock 掉，发现不了。加锁一律用 $executeRaw，或显式 ::text 转换。
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === 'generated' ? [] : sourceFiles(full);
    }
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('advisory lock raw queries', () => {
  it('never runs pg_advisory_xact_lock through $queryRaw without a cast', () => {
    const root = join(__dirname, '..');
    const offenders = sourceFiles(root).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(
          ({ line }) =>
            /\$queryRaw`SELECT pg_advisory_xact_lock\(/.test(line) &&
            !/\)::\w+`/.test(line),
        )
        .map(({ index }) => `${relative(root, file)}:${index + 1}`),
    );
    expect(offenders).toEqual([]);
  });
});
