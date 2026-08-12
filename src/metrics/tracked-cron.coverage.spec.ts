import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CronExpression } from '@nestjs/schedule';
import {
  intervalSecondsFor,
  KNOWN_CRON_EXPRESSIONS,
} from './tracked-cron.decorator';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!path.endsWith('.ts') || path.endsWith('.spec.ts')) return [];
    return [path];
  });
}

const FILES = sourceFiles(SRC).map((path) => ({
  path,
  source: readFileSync(path, 'utf8'),
}));

describe('scheduled job coverage', () => {
  it('has no bare @Cron left — every scheduled job must be observable', () => {
    // 裸 @Cron 不产生心跳，任务停摆时没有任何信号。这条断言是把「新加定时
    // 任务时忘了用 TrackedCron」这个必然会发生的疏漏钉死在 CI 上。
    const offenders = FILES.filter(({ source }) =>
      /(^|[^a-zA-Z])@Cron\(/m.test(source),
    ).map(({ path }) => path.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  it('maps every cron expression actually used to an interval', () => {
    const used = new Set<string>();
    for (const { source } of FILES) {
      for (const match of source.matchAll(
        /@TrackedCron\(\s*CronExpression\.([A-Z0-9_]+)/g,
      )) {
        used.add(match[1]);
      }
    }

    expect(used.size).toBeGreaterThan(0);
    for (const name of used) {
      const expression = (CronExpression as Record<string, string>)[name];
      expect(expression).toBeDefined();
      // 漏配会静默退化成 24h 兜底阈值，让每分钟任务停摆一整天才告警。
      expect(KNOWN_CRON_EXPRESSIONS).toContain(expression);
    }
  });

  it('gives every registered job a distinct name', () => {
    const names: string[] = [];
    let callSites = 0;
    for (const { source } of FILES) {
      callSites += [...source.matchAll(/@TrackedCron\(/g)].length;
      // 跨行匹配：prettier 会把参数较长的调用点拆成多行并加尾逗号，早先那版
      // 「一行内到右括号」的正则因此静默漏掉了两个任务 —— 漏掉的任务不会报错，
      // 只是不再被这条唯一性断言覆盖。
      for (const match of source.matchAll(
        /@TrackedCron\(\s*CronExpression\.[A-Z0-9_]+\s*,\s*'([^']+)'/g,
      )) {
        names.push(match[1]);
      }
    }

    // 抽取数必须等于调用点数。相等才说明正则没有漏匹配 —— 用它替代写死的
    // 期望条数，新增任务时不用改这里，正则失配时又必红。
    expect(names.length).toBe(callSites);
    expect(callSites).toBeGreaterThanOrEqual(18);
    // 重名会让两个任务共用一条心跳序列：其中一个停了，另一个的成功还在刷新
    // 时间戳，告警永远不响。
    expect(new Set(names).size).toBe(names.length);
  });

  it('falls back conservatively rather than dropping an unknown expression', () => {
    expect(intervalSecondsFor('7 3 * * 1')).toBe(24 * 60 * 60);
    expect(intervalSecondsFor(CronExpression.EVERY_MINUTE)).toBe(60);
  });
});
