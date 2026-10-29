import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const RULES = readText(join(ROOT, 'monitoring/prometheus/alerts.yml'));
const ALERTMANAGER = readFileSync(
  join(ROOT, 'monitoring/alertmanager/alertmanager.yml'),
  'utf8',
).replace(/\r\n/g, '\n');
const PROMETHEUS = readText(join(ROOT, 'monitoring/prometheus/prometheus.yml'));
const PROMETHEUS_PROD = readText(join(ROOT, 'monitoring/prometheus/prometheus.prod.yml'));
const JOBS_DASHBOARD = readText(join(ROOT, 'monitoring/grafana/dashboards/circle-be-jobs.json'));
const DELIVERIES_DASHBOARD = readText(
  join(ROOT, 'monitoring/grafana/dashboards/circle-be-deliveries.json'),
);
const LOGS_COMPOSE = readText(join(ROOT, 'monitoring/docker-compose.logs.yml'));
const LOGS_DOC = readText(join(ROOT, 'monitoring/logs.md'));
const RULE_TESTS = readText(join(ROOT, 'monitoring/prometheus/alerts.test.yml'));

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
  assert.match(expr, /time\(\) - max by \(exported_job\)/);
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
  assert.match(expr, /max by \(exported_job\)/);
});

test('cron alerts preserve the application job label after scraping', () => {
  for (const name of ['CronJobStalled', 'CronJobFailing']) {
    const expr = alertExpr(name);
    assert.match(expr, /by \(exported_job\)/);
    assert.doesNotMatch(expr, /by \(job\)/);
    assert.match(expr, /summary: 'Scheduled job \{\{ \$labels\.exported_job \}\}/);
  }
});

test('DbPoolExhausted scales with the configured pool size', () => {
  const expr = alertExpr('DbPoolExhausted');
  // 写死阈值在小池子上漏报、在大池子上误报。
  assert.match(expr, /circle_db_pool_max/);
  assert.doesNotMatch(expr, />\s*5\b/);
  assert.match(expr, /max by \(instance\) \(circle_db_pool_waiting\)/);
  assert.match(expr, /max by \(instance\) \(circle_db_pool_max\)/);
});

test('monitoring components are scraped and their failures alert', () => {
  for (const config of [PROMETHEUS, PROMETHEUS_PROD]) {
    assert.match(config, /job_name: alertmanager[\s\S]*targets: \['alertmanager:9093'\]/);
    assert.match(config, /job_name: grafana[\s\S]*targets: \['grafana:3000'\]/);
  }
  for (const name of ['AlertmanagerNotificationFailures', 'AlertmanagerConfigReloadFailed', 'PrometheusRuleEvaluationFailures']) {
    assert.ok(alertExpr(name));
  }
});

test('optional log pipeline exposes private self-metrics only when its overlay is enabled', () => {
  for (const config of [PROMETHEUS, PROMETHEUS_PROD]) {
    assert.match(config, /file_sd_configs:[\s\S]*\/etc\/prometheus\/log-targets\/\*\.yml/);
  }
  assert.match(LOGS_COMPOSE, /prometheus:\n\s+networks: \[default, circle-be, logs\][\s\S]*\.\/prometheus\/logs-targets\.yml:\/etc\/prometheus\/log-targets\/targets\.yml:ro/);
  assert.match(LOGS_COMPOSE, /--server\.http\.listen-addr=0\.0\.0\.0:12345/);
  assert.ok(alertExpr('LogPipelineDroppedEntries'));
  assert.ok(alertExpr('LogPipelineDeliveryStalled'));
  assert.match(LOGS_DOC, /docker compose --env-file monitoring\/\.env[\s\S]*stop alloy loki/);
  assert.match(LOGS_DOC, /docker compose --env-file monitoring\/\.env[\s\S]*recreate prometheus grafana/);
});

test('promtool fixtures cover post-scrape cron isolation and monitoring self-alert behavior', () => {
  for (const scenario of [
    '共享抓取 job 下健康任务不能掩盖失败任务',
    '同周期健康任务不能掩盖停摆任务',
    '同一任务蓝绿心跳有一个恢复就不报',
    'Alertmanager 通知失败计数增长并在窗口过期后恢复',
    'Alertmanager 配置重载失败持续后触发并在成功后恢复',
    'Prometheus 规则评估失败计数增长并在窗口过期后恢复',
    '监控自检指标为零或可选日志栈缺席时不报',
    'Grafana 和可选日志目标宕机触发 TargetDown',
    'Alloy 丢弃计数单次增长触发并在窗口过期后恢复',
    'Alloy 持续重试且目标健康时触发',
  ]) {
    assert.match(RULE_TESTS, new RegExp(`name: ${scenario}`), `missing promtool scenario: ${scenario}`);
  }
});

test('jobs dashboard uses exported cron job and reset-safe dead-letter queries', () => {
  const dashboard = JSON.parse(JOBS_DASHBOARD);
  const expressions = dashboard.panels.flatMap((panel) => panel.targets ?? []).map((target) => target.expr ?? '');
  for (const expression of expressions.filter((value) => value.includes('circle_cron_'))) {
    assert.doesNotMatch(expression, /by \(job(?:,|\))/);
  }
  const deadLetterChange = expressions.find((value) => value.includes('circle_outbox_dead[1h]'));
  assert.ok(deadLetterChange, 'dead-letter change panel not found');
  assert.doesNotMatch(deadLetterChange, /delta\(/);
  assert.match(deadLetterChange, /min_over_time\(/);
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
    // 同理:库挂着时对账跑不成、结果不会更新,产生不了新的误报;而此前已经查出的
    // 余额与流水不一致是钱错了,不能被一次 DB 故障静音。
    'WalletLedgerMismatch',
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

/** 同名的所有告警块（同一个告警名按严重度分档时会有多条）。 */
function alertExprs(name) {
  const blocks = [
    ...RULES.matchAll(
      new RegExp(`- alert: ${name}\\n([\\s\\S]*?)(?=\\n {6}- alert:|\\n {2}- name:|$)`, 'g'),
    ),
  ].map((m) => m[1]);
  assert.ok(blocks.length > 0, `alert ${name} not found`);
  return blocks;
}

test('a broken public entry point pages, but a single probe blip does not', () => {
  // 其余告警都来自 compose 内网里的直连：DNS 指错、证书过期、Caddy 配坏时它们
  // 一切正常，而用户已经进不来。这条是唯一从用户的路径看服务的信号。
  const expr = alertExpr('PublicEndpointDown');
  assert.match(expr, /probe_success\{job="blackbox-http"\} == 0/);
  assert.match(expr, /for: 2m/);
  assert.match(expr, /severity: critical/);
});

test('certificate expiry escalates per certificate, never across domains', () => {
  // Caddy 在剩 ~30 天时续期：剩 14 天说明续期已经连续失败两周多。
  const warning = alertExpr('TlsCertificateExpiringSoon');
  const critical = alertExpr('TlsCertificateExpiryImminent');
  for (const expr of [warning, critical]) {
    assert.match(expr, /probe_ssl_earliest_cert_expiry\{job="blackbox-http"\} - time\(\)/);
  }
  assert.match(warning, /< 14 \* 86400/);
  assert.match(warning, /severity: warning/);
  assert.match(critical, /< 3 \* 86400/);
  assert.match(critical, /severity: critical/);

  // 两档必须是不同的告警名。共用一个名字时，通用的「critical 压掉同名 warning」
  // 抑制只比 alertname：api 证书的 critical 会把 admin 证书那条毫不相干的 warning
  // 一起静音 —— 两个域名各自续期，同时出问题完全可能。
  assert.equal(alertExprs('TlsCertificateExpiringSoon').length, 1);
  // 同一张证书两档都响时只留 critical：这条抑制必须按 instance 配对。
  assert.match(
    ALERTMANAGER,
    /alertname = "TlsCertificateExpiryImminent"\n\s*target_matchers:\n\s*- alertname = "TlsCertificateExpiringSoon"\n\s*equal: \['instance'\]/,
  );
});

test('an empty probe list is loud, but only where the blackbox exporter runs', () => {
  const expr = alertExpr('PublicProbeNotConfigured');
  // 目标文件漏配时 probe_success 根本不存在，上面两条永远不会响。
  assert.match(expr, /absent\(probe_success\{job="blackbox-http"\}\)/);
  // exporter 只在生产 overlay 里：少了这个前提，每台开发机上都会常年红。
  assert.match(expr, /and on\(\) \(up\{job="blackbox-exporter"\} == 1\)/);
  assert.match(expr, /severity: warning/);
});

test('a missing backend mutes the API probe it necessarily breaks, but not the admin site', () => {
  // 后端一个副本都不在时，公网 API 探测必然失败 —— 同一件事不报两遍。管理后台是
  // 另一个容器，它的探测失败和后端无关，必须照常报，所以只压 component="api"。
  assert.match(
    ALERTMANAGER,
    /alertname = "CircleBeNoTarget"\n\s*target_matchers:\n\s*- alertname = "PublicEndpointDown"\n\s*- component = "api"/,
  );
});

test('the critical disk tier watches exactly the disks the warning tier does', () => {
  const warning = alertExpr('HostDiskFilling');
  const critical = alertExpr('HostDiskNearlyFull');
  // 选择器一字不差：critical 一档要是漏了 readonly/fstype 的排除，squashfs 会让它
  // 在装了 snap 的主机上常年 critical。
  const selector = (expr) => expr.match(/expr: \|\n([\s\S]*?)\n {8}for:/)[1].replace(/< 0\.\d+/, '');
  assert.equal(selector(critical), selector(warning));
  assert.match(critical, /< 0\.05/);
  assert.match(critical, /severity: critical/);
  // 不同告警名 + 按盘配对的专用抑制：一块盘的 critical 不能静音另一块盘的 warning。
  assert.equal(alertExprs('HostDiskFilling').length, 1);
  assert.match(
    ALERTMANAGER,
    /alertname = "HostDiskNearlyFull"\n\s*target_matchers:\n\s*- alertname =~ "HostDiskFilling\|HostDiskWillFillWithin24h"\n\s*equal: \['instance', 'mountpoint'\]/,
  );
});

test('a crash loop counts restart series per container, not start-time changes', () => {
  const expr = alertExpr('ContainerRestartLoop');
  // cAdvisor 的 container_start_time_seconds 是创建时间，重启时不变 —— changes()
  // 在它上面恒为 0。重启体现在 restartcount 标签上：每次一条新序列。
  const query = expr.match(/expr: (.*)\n/)[1];
  assert.doesNotMatch(query, /changes\(/);
  assert.equal(
    query,
    'count by (name) (count_over_time(container_start_time_seconds{name!=""}[15m])) - 1 >= 3',
  );
});

test('unhandled rejections alert on new arrivals, not on the standing count', () => {
  const expr = alertExpr('UnhandledRejectionsOccurring');
  assert.match(expr, /increase\(circle_unhandled_rejections_total\{job="circle-be"\}\[15m\]\)/);
  // increase() 吃掉新序列的首个样本；冷启动漏出的那条靠这一段补。
  assert.match(
    expr,
    /circle_unhandled_rejections_total\{job="circle-be"\}\n\s*unless circle_unhandled_rejections_total\{job="circle-be"\} offset 15m/,
  );
  assert.match(expr, /severity: warning/);
});

const BACKUP_CHECK = readText(join(ROOT, 'deploy/backup/check.sh'));
const BACKUP_DOCKERFILE = readText(join(ROOT, 'docker/backup/Dockerfile'));
const BACKUP_COMPOSE = readText(join(ROOT, 'docker-compose.backup.yml'));
const MONITORING_PROD_COMPOSE = readText(join(ROOT, 'monitoring/docker-compose.prod.yml'));

test('backup self-check results reach Prometheus through one consistent path', () => {
  const dir = BACKUP_CHECK.match(/BACKUP_METRICS_DIR:-([^}]+)\}/)[1];
  // 镜像里预建并归 postgres 所有：命名卷首次挂载时继承这个属主，uid 70 才写得进去。
  assert.match(BACKUP_DOCKERFILE, new RegExp(`mkdir -p ${dir}\\b`));
  assert.match(BACKUP_DOCKERFILE, new RegExp(`chown postgres:postgres ${dir}\\b`));
  // backup 写、backup-metrics 读的是同一个卷。
  assert.match(BACKUP_COMPOSE, new RegExp(`- backup_metrics:${dir}\\n`));
  assert.match(BACKUP_COMPOSE, /- backup_metrics:\/textfile:ro/);
  assert.match(BACKUP_COMPOSE, /--collector\.textfile\.directory=\/textfile/);
  // Prometheus 按服务名发现它；名字对不上就是一个永远没有目标的 job。
  assert.match(BACKUP_COMPOSE, /\n {2}backup-metrics:\n/);
  assert.match(PROMETHEUS_PROD, /job_name: backup\n\s*dns_sd_configs:\n\s*- names: \['backup-metrics'\]\n\s*type: A\n\s*port: 9100/);
  // 开发配置里没有它：开发机不跑备份 overlay。
  assert.doesNotMatch(PROMETHEUS, /backup-metrics/);
  // 与监控栈锁定的 node-exporter 同一版本。
  const pinned = MONITORING_PROD_COMPOSE.match(/image: (prom\/node-exporter:v[\d.]+)/)[1];
  assert.match(BACKUP_COMPOSE, new RegExp(`image: ${pinned.replace(/[.]/g, '\\.')}\\n`));
});

test('backup alerts cover a failing check, a stopped check, no backups at all and the restore drill', () => {
  assert.deepEqual(alertNamesInGroup('backups'), [
    'BackupCheckFailing',
    'BackupCheckStale',
    'BackupCheckNotReporting',
    'BackupNeverCompleted',
    'ReleaseOffsiteBackupFailed',
    'BackupRestoreDrillFailing',
    'BackupRestoreDrillStale',
    'BackupRestoreDrillNeverPassed',
  ]);
  // 演练的「最近一次通过」只由通过的那一轮写，失败不会刷新它；「从没通过」只在
  // 备份自检确实在跑的机器上才算数。
  assert.match(
    alertExpr('BackupRestoreDrillStale'),
    /time\(\) - circle_backup_drill_last_success_timestamp_seconds\) > 8 \* 86400/,
  );
  assert.match(
    alertExpr('BackupRestoreDrillNeverPassed'),
    /absent\(circle_backup_drill_last_success_timestamp_seconds\)\s+and on\(\) \(time\(\) - circle_backup_check_last_run_timestamp_seconds < 3 \* 3600\)/,
  );
  // 连续两次失败才报：gauge 一小时不变，for 去不了抖。
  assert.match(
    alertExpr('BackupCheckFailing'),
    /max_over_time\(circle_backup_check_success\[70m\]\) == 0/,
  );
  assert.match(
    alertExpr('BackupNeverCompleted'),
    /absent\(circle_backup_check_success\{check="backup_freshness"\}\)/,
  );
  assert.match(alertExpr('BackupCheckFailing'), /severity: critical/);
  assert.match(alertExpr('BackupCheckFailing'), /\{\{ \$labels\.check \}\}/);
  assert.match(
    alertExpr('BackupCheckStale'),
    /time\(\) - circle_backup_check_last_run_timestamp_seconds > 3 \* 3600/,
  );
  const notReporting = alertExpr('BackupCheckNotReporting');
  assert.match(notReporting, /absent\(circle_backup_check_last_run_timestamp_seconds\)/);
  // postgres-exporter 只在生产 overlay 里：少了这个前提，每台开发机上都会常年红。
  assert.match(notReporting, /and on\(\) \(up\{job="postgres-exporter"\} == 1\)/);
  // 每个检查名都必须是 check.sh 真的会写出来的。
  for (const check of ['postgres_archive', 'backup_freshness', 'destination_bucket', 'minio_source']) {
    assert.match(BACKUP_CHECK, new RegExp(`record ${check} [01]`));
  }
});

test('delivery alerts measure real channel failures with a minimum volume', () => {
  assert.deepEqual(alertNamesInGroup('deliveries'), [
    'PushDeliveryFailing',
    'EmailCodeSendFailing',
    'DependencyRequestsFailing',
  ]);
  const push = alertExpr('PushDeliveryFailing');
  assert.match(push, /circle_push_delivery_terminal_total/);
  assert.doesNotMatch(push, /circle_push_deliveries_total/);
  // 失效 token 是正常流失：进分子的话一批老设备就能把失败率拉过阈值。
  assert.match(push, /result=~"retryable\|rejected"/);
  assert.doesNotMatch(push, /dead_token/);
  // 两个 provider 的凭证/配额互不相干，必须分开算。
  assert.match(
    push,
    /sum by \(provider\) \(increase\(circle_push_delivery_terminal_total\{job="circle-be"\}\[15m\]\)\) >= 20/,
  );
  const email = alertExpr('EmailCodeSendFailing');
  // 生产上没配 SMTP 时 mailer 直接不可用，同样意味着没人能收到验证码。
  assert.match(email, /result=~"failure\|unavailable"/);
  assert.match(email, /\[15m\]\)\) >= 3/);
  assert.match(email, /severity: critical/);
});

test('push failure dashboard uses exactly-once terminal outcomes', () => {
  const dashboard = JSON.parse(DELIVERIES_DASHBOARD);
  const panel = dashboard.panels.find(
    (candidate) => candidate.title === 'Push failure ratio by provider (15m)',
  );
  assert.ok(panel, 'push failure ratio panel not found');
  const expressions = panel.targets.map((target) => target.expr ?? '');
  assert.ok(
    expressions.every((expression) =>
      expression.includes('circle_push_delivery_terminal_total'),
    ),
  );
  assert.ok(
    expressions.every(
      (expression) => !expression.includes('circle_push_deliveries_total'),
    ),
  );
});

test('CronJobStalled never judges a heartbeat finer than scrape and evaluation can see', () => {
  // 5～10 秒一跑的 @TrackedInterval 任务，3 × 周期只有 15～30 秒，而抓取和求值都是
  // 15 秒一次：没有下限的话，正常运转的任务会周期性地连响几小时。
  assert.match(
    alertExpr('CronJobStalled'),
    /> clamp_min\(3 \* max by \(exported_job\) \(circle_cron_interval_seconds\), 120\)/,
  );
});

const DISK_SELECTOR =
  '{fstype=~"ext4|xfs|btrfs|zfs|ext3", mountpoint!~"/(boot|snap)(/.*)?"}';

test('disk trend and inode alerts watch exactly the disks the space alerts do', () => {
  // 少一个 fstype / readonly 排除，squashfs 就会让它们在装了 snap 的主机上常年响。
  for (const name of [
    'HostDiskWillFillWithin24h',
    'HostInodesLow',
    'HostInodesNearlyExhausted',
  ]) {
    const expr = alertExpr(name);
    const selectors = [...expr.matchAll(/\{fstype=~[^}]*\}/g)].map((m) => m[0]);
    assert.ok(selectors.length >= 2, `${name} has no filesystem selector`);
    for (const selector of selectors) assert.equal(selector, DISK_SELECTOR, name);
    assert.match(expr, /and on\(instance, mountpoint\) node_filesystem_readonly == 0/);
  }
  // 趋势只看已经不太空的盘：空盘上一次大文件写入也会让斜率短暂为负。
  assert.match(alertExpr('HostDiskWillFillWithin24h'), /predict_linear\(node_filesystem_avail_bytes\{[^}]*\}\[6h\], 24 \* 3600\) < 0/);
  assert.match(alertExpr('HostDiskWillFillWithin24h'), /< 0\.4/);
  // btrfs/zfs 报告 inode 总数为 0。
  for (const name of ['HostInodesLow', 'HostInodesNearlyExhausted']) {
    assert.match(alertExpr(name), /\(node_filesystem_files\{[^}]*\} > 0\)/);
  }
  assert.match(
    ALERTMANAGER,
    /alertname = "HostInodesNearlyExhausted"\n\s*target_matchers:\n\s*- alertname = "HostInodesLow"\n\s*equal: \['instance', 'mountpoint'\]/,
  );
});

test('an unreachable object store pages once and mutes only its own failure rate', () => {
  const expr = alertExpr('ObjectStoreUnreachable');
  // min：只要有一个在服务的实例连不上就响（与 RedisDown 同理）。
  assert.match(expr, /min\(circle_object_store_up\) == 0/);
  assert.match(expr, /severity: critical/);
  // LiveKit 的失败与存储无关，必须照常报 —— 抑制只压 object_storage。
  assert.match(
    ALERTMANAGER,
    /alertname = "ObjectStoreUnreachable"\n\s*target_matchers:\n\s*- alertname = "DependencyRequestsFailing"\n\s*- dependency = "object_storage"/,
  );
  const dependency = alertExpr('DependencyRequestsFailing');
  // not_found（对象不存在）是正常结果，不进分子。
  assert.equal([...dependency.matchAll(/result="failure"/g)].length, 2);
  assert.doesNotMatch(dependency, /not_found/);
  // 可达性探测的 HeadBucket 归 circle_object_store_up 管；分子分母都要排除，
  // 否则每 15 分钟约 30 次探测成功会把服务端写入的失败稀释掉。
  assert.equal([...dependency.matchAll(/operation!="HeadBucket"/g)].length, 3);
});

const OFFSITE_BACKUP = readText(join(ROOT, 'deploy/offsite-backup.sh'));

test('the release-time off-host backup result lands in the volume backup-metrics exports', () => {
  const dir = BACKUP_CHECK.match(/BACKUP_METRICS_DIR:-([^}]+)\}/)[1];
  // 与 check.sh 写同一个目录 —— 卷挂在这里，backup-metrics 读的就是它。
  assert.ok(OFFSITE_BACKUP.includes(`d=${dir};`), 'offsite metric written outside the backup_metrics volume');
  assert.match(OFFSITE_BACKUP, /label=com\.docker\.compose\.service=backup/);
  assert.match(OFFSITE_BACKUP, /circle_release_offsite_backup_success/);
  assert.match(alertExpr('ReleaseOffsiteBackupFailed'), /circle_release_offsite_backup_success == 0/);
});

test('every service the backup overlay starts rotates its container logs', () => {
  for (const service of ['backup', 'backup-metrics']) {
    const block = BACKUP_COMPOSE.match(
      new RegExp(`\n {2}${service}:\n([\\s\\S]*?)(?=\n {2}[a-z][a-z-]*:\n|\nvolumes:)`),
    );
    assert.ok(block, `service ${service} not found`);
    assert.match(block[1], /logging: \*default-logging/, `${service} has no log rotation`);
  }
  assert.match(BACKUP_COMPOSE, /x-logging: &default-logging\n\s*driver: json-file\n\s*options:\n\s*max-size: '10m'\n\s*max-file: '3'/);
});
