import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

/**
 * Prisma 7 把 `distinct` + `take` 编译成**没有 LIMIT** 的 SQL:去重和截断都在
 * 内存里做,`take` 只是装饰。发帖扇出曾经这样写,注释里的「最多 500 人」安全阀
 * 实际是把 50 个圈子 × 3000 人整批读回来再切。
 *
 * 需要「去重 + 上限」时用 groupBy({ by, orderBy, take }),它编译成
 * `GROUP BY ... ORDER BY ... LIMIT n`。这个守卫扫全仓,防止同类写法再出现。
 */
const SRC = resolve(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'generated' ? [] : sourceFiles(path);
    }
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

/** 从 `{` 开始找到配对的 `}`;字符串里的括号不算。 */
function closingBrace(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** `distinct:` 所在对象字面量的同一层里有没有 `take:`。 */
function distinctWithTake(source: string): number[] {
  const hits: number[] = [];
  for (const match of source.matchAll(/\bdistinct\s*:/g)) {
    const at = match.index;
    // 往回找包住它的那个 `{`。
    let depth = 0;
    let open = -1;
    for (let i = at - 1; i >= 0; i -= 1) {
      if (source[i] === '}') depth += 1;
      else if (source[i] === '{') {
        if (depth === 0) {
          open = i;
          break;
        }
        depth -= 1;
      }
    }
    if (open < 0) continue;
    const close = closingBrace(source, open);
    if (close < 0) continue;
    // 只看这一层:把嵌套的对象(include/select 里的 take)挖掉。
    let level = '';
    for (let i = open + 1; i < close; i += 1) {
      if (source[i] === '{') {
        i = closingBrace(source, i);
        continue;
      }
      level += source[i];
    }
    if (/\btake\s*:/.test(level)) {
      hits.push(source.slice(0, at).split('\n').length);
    }
  }
  return hits;
}

describe('Prisma query shape guard', () => {
  it('never combines distinct with take (Prisma drops the LIMIT)', () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      distinctWithTake(readFileSync(file, 'utf8')).map(
        (line) => `${relative(process.cwd(), file)}:${line}`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  it('detects the pattern it guards against', () => {
    const bad = `prisma.x.findMany({ where: { a: 1 }, distinct: ['a'], take: 5 })`;
    const nested = `prisma.x.findMany({ distinct: ['a'], include: { y: { take: 5 } } })`;

    expect(distinctWithTake(bad)).toEqual([1]);
    expect(distinctWithTake(nested)).toEqual([]);
  });
});
