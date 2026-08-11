import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULES = readFileSync(join(ROOT, 'monitoring/prometheus/alerts.yml'), 'utf8');
const ALERTMANAGER = readFileSync(
  join(ROOT, 'monitoring/alertmanager/alertmanager.yml'),
  'utf8',
);

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

/** 某个规则组里所有告警的名字。 */
function alertNamesInGroup(group) {
  const match = RULES.match(
    new RegExp(`\\n {2}- name: ${group}\\n([\\s\\S]*?)(?=\\n {2}- name:|$)`),
  );
  assert.ok(match, `rule group ${group} not found`);
  return [...match[1].matchAll(/- alert: (\w+)/g)].map((m) => m[1]);
}

/** 某条抑制规则的 target 匹配正则(source 告警名唯一标识这条规则)。 */
function inhibitTargets(sourceAlert) {
  const match = ALERTMANAGER.match(
    new RegExp(
      `alertname = "${sourceAlert}"\\n\\s*target_matchers:\\n\\s*- alertname =~ "([^"]+)"`,
    ),
  );
  assert.ok(match, `no inhibit rule sourced from ${sourceAlert}`);
  return new RegExp(`^(?:${match[1]})$`);
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
  // 按 `> 0` 告警会在第一行死信之后永久 firing —— 本文件反复警告的
  // 「永远红 → 训练运维忽略告警」。
  for (const name of ['OutboxDeadLettersAppearing', 'GiftCardPermanentlyLost']) {
    const expr = alertExpr(name);
    assert.match(
      expr,
      /min_over_time\(circle_outbox_dead/,
      `${name} must compare against the window minimum`,
    );
    // delta() 只看窗口两端。文档里的补救手段(把 cardAttempts 清零)会让这个
    // gauge 回落,回落之后同一小时内新增的永久丢失就被算成负数、彻底哑掉。
    // 行为断言见 monitoring/prometheus/alerts.test.yml。
    assert.doesNotMatch(
      expr,
      /delta\(/,
      `${name} must not use delta(): the gauge decreases when dead rows are manually recovered`,
    );
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

test('CronJobFailing is cadence-independent', () => {
  const expr = alertExpr('CronJobFailing');
  // rate(...[15m]) 配 for: 15m 对每小时/每天的任务打不中:单次失败的增量在
  // for 满足之前就滑出窗口。行为断言见 monitoring/prometheus/alerts.test.yml。
  assert.doesNotMatch(expr, /rate\(/);
  assert.match(expr, /circle_cron_last_result/);
  assert.match(expr, /max by \(job\)/);
});

test('DbPoolExhausted scales with the configured pool size', () => {
  const expr = alertExpr('DbPoolExhausted');
  // 写死阈值在小池子上漏报、在大池子上误报。
  assert.match(expr, /circle_db_pool_max/);
  assert.doesNotMatch(expr, />\s*5\b/);
});

test('a Postgres outage inhibits every job alert it necessarily causes', () => {
  // 整个 jobs 组读的都是 Postgres 上的东西:cron 记账要写库才能推进,五个
  // outbox 探测直接查表。库一挂它们必然一起响 —— 一次事故五种叫法,正是
  // 这套配置反复警惕的告警疲劳。amtool 只能测路由、测不了抑制,所以这里
  // 直接对配置断言,而且是**清单式**的:新加的 job 告警不进抑制名单就会红,
  // 不必指望有人记得回来补。
  const inhibited = inhibitTargets('PostgresDown');

  // 刻意不抑制的,必须在这里写明理由 —— 静默地漏掉和刻意地豁免,配置文件上
  // 长得一模一样。
  const deliberatelyNotInhibited = new Set([
    // 库挂着时 gauge 冻住,本来就产生不了新的正向跳变;而事故前刚落下的那条
    // 永久丢失(钱已结算、凭证没了)必须继续叫人,不能被一次 DB 故障顺手静音。
    'OutboxDeadLettersAppearing',
    'GiftCardPermanentlyLost',
  ]);

  const missing = alertNamesInGroup('jobs').filter(
    (name) => !inhibited.test(name) && !deliberatelyNotInhibited.has(name),
  );
  assert.deepEqual(
    missing,
    [],
    `these job alerts fire on their own during a Postgres outage: ${missing.join(', ')}`,
  );
});

test('the backend being absent inhibits the same job alerts', () => {
  // 后端一个副本都不在时同理 —— 只是这里的下游是「指标压根不再产生」。
  const inhibited = inhibitTargets('CircleBeNoTarget');
  for (const name of ['CronJobStalled', 'CronJobFailing', 'OutboxBacklogStuck']) {
    assert.ok(inhibited.test(name), `${name} must be inhibited by CircleBeNoTarget`);
  }
});

test('OutboxProbeStale covers the queue whose probe silently keeps failing', () => {
  // collectOutboxDepths 单队列失败只丢它自己(整轮 reject 会让所有队列的序列
  // 一起消失)。代价是失败的队列保留上一次读数不动、refresh() 仍然成功 ——
  // 没有这条规则的话,一个堆积中的队列可以永远停在 0 上装健康。
  const expr = alertExpr('OutboxProbeStale');
  assert.match(expr, /circle_outbox_last_probe_timestamp_seconds/);
  assert.match(expr, /time\(\) -/);
});
