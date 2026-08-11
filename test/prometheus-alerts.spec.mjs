import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULES = readFileSync(join(ROOT, 'monitoring/prometheus/alerts.yml'), 'utf8');

/**
 * 这里没有 PromQL 引擎(仓库里没有 promtool,为一条规则引入它不划算),
 * 所以测的是规则里那个 fstype 选择器本身的语义:把正则从表达式里抽出来,
 * 对真实的文件系统类型求值。这能钉住「squashfs 会不会被选中」这个具体问题,
 * 但它不等价于端到端跑一遍规则 —— 阈值、for、labels 仍然只有人工审阅。
 */
function alertExpr(name) {
  const match = RULES.match(
    new RegExp(`- alert: ${name}\\n([\\s\\S]*?)(?=\\n {6}- alert:|\\n {2}- name:|$)`),
  );
  assert.ok(match, `alert ${name} not found`);
  return match[1];
}

function fstypeMatchers(expr) {
  const matchers = [...expr.matchAll(/fstype=~"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(matchers.length > 0, 'expected an fstype=~ selector');
  return matchers.map((source) => new RegExp(`^(?:${source})$`));
}

test('HostDiskFilling ignores pseudo and read-only filesystems', () => {
  const expr = alertExpr('HostDiskFilling');
  const matchers = fstypeMatchers(expr);
  const matchesAll = (fstype) => matchers.every((re) => re.test(fstype));

  // node_exporter 把 snap 的 squashfs 报成 100% 已用、可用 0 字节。
  // 选中它的话这条告警在装了 snap 的主机上永久 firing,运维学会无视,
  // 而它本来是用来发现 Kafka/Mongo 撑满磁盘的。
  for (const pseudo of [
    'squashfs',
    'tmpfs',
    'overlay',
    'devtmpfs',
    'ramfs',
    'iso9660',
    'proc',
    'sysfs',
    'cgroup2',
    'fuse.snapfuse',
  ]) {
    assert.equal(matchesAll(pseudo), false, `${pseudo} must not be alerted on`);
  }

  // 真正会被写满的持久化文件系统必须还在覆盖范围内。
  for (const real of ['ext4', 'xfs', 'btrfs', 'zfs', 'ext3']) {
    assert.equal(matchesAll(real), true, `${real} must stay covered`);
  }
});

test('HostDiskFilling excludes read-only mounts explicitly', () => {
  const expr = alertExpr('HostDiskFilling');
  // 只读挂载(只读 bind、恢复模式镜像)不会「填满」,却常年 0 可用。
  assert.match(expr, /node_filesystem_readonly == 0/);
});

test('HostDiskFilling still guards the disks the flood actually lands on', () => {
  const expr = alertExpr('HostDiskFilling');
  // 阈值与观察窗口是这条告警的意义所在,别在收窄 fstype 时顺手改掉。
  assert.match(expr, /< 0\.15/);
  assert.match(alertExpr('HostDiskFilling'), /for: 10m/);
});

test('CronJobStalled derives its threshold from the exported interval', () => {
  const expr = alertExpr('CronJobStalled');
  // 写死阈值就必然要么让每日任务天天误报,要么让每分钟任务停摆一天才响。
  // 周期由 circle_cron_interval_seconds 从代码里带过来,新任务自动被覆盖。
  assert.match(expr, /circle_cron_interval_seconds/);
  assert.match(expr, /time\(\) - max by \(job\)/);
  // max by (job):蓝绿发布期间两个颜色同时在跑,只要有一个把活干了就不该响。
  assert.doesNotMatch(expr, /min by \(job\)/);
});

test('dead-letter alerts fire on new arrivals, not on the standing count', () => {
  // 死信是只增不减的存量。按 `> 0` 告警会在第一行死信之后永久 firing ——
  // 本文件反复警告的「永远红 → 训练运维忽略告警」。必须用 delta。
  for (const name of ['OutboxDeadLettersAppearing', 'GiftCardPermanentlyLost']) {
    const expr = alertExpr(name);
    assert.match(expr, /delta\(circle_outbox_dead/, `${name} must use delta()`);
  }
});

test('gift-card dead letters are not double-reported', () => {
  // 钱已结算、卡永久丢失是 critical;通用死信告警必须把它排除,否则同一件事
  // 在两个严重度上各响一次。
  assert.match(
    alertExpr('OutboxDeadLettersAppearing'),
    /queue!="gift_card"/,
  );
  assert.match(alertExpr('GiftCardPermanentlyLost'), /severity: critical/);
});

test('session-revocation backlog is critical, like RedisDown on the same path', () => {
  // Redis 挂了撤销 fail-open,队列堵了撤销压根没执行 —— 同一条安全路径的
  // 两个故障点,都必须叫醒人。
  const expr = alertExpr('SessionRevocationOutboxStuck');
  assert.match(expr, /severity: critical/);
  assert.match(expr, /queue="session_revocation"/);
});

test('OutboxBacklogStuck clears the gift-card grace period', () => {
  // gift_card 处理器有 2 分钟宽限期才补发,所以稳态下 oldestAge 常驻 ~120s。
  // 阈值必须显著高于它,否则这条常年 firing。
  const expr = alertExpr('OutboxBacklogStuck');
  const threshold = Number(expr.match(/>\s*(\d+)/)?.[1]);
  assert.ok(threshold >= 600, `threshold ${threshold}s is too close to the 120s grace period`);
});

test('Watchdog is unconditional and kept out of the normal severities', () => {
  const expr = alertExpr('Watchdog');
  // 它的意义在于「永远 firing」,外部服务收不到才报警。加 for: 或让它带上
  // warning/critical 都会把它并进普通告警流,那就完全失去作用了。
  assert.match(expr, /expr: vector\(1\)/);
  assert.match(expr, /severity: none/);
  assert.doesNotMatch(expr, /for:/);
});
