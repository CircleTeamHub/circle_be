import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 告警规则写在仓库里不等于数据真的在：采集项没开、任务没排进调度、抓取 job 没配、
 * env 文件被发版删掉，规则都会安静地永远不响。这里把这些接线点逐个钉住。
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readText = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');

const MONITORING_COMPOSE = readText('monitoring/docker-compose.prod.yml');
const PROMETHEUS_PROD = readText('monitoring/prometheus/prometheus.prod.yml');
const BACKUP_COMPOSE = readText('docker-compose.backup.yml');
const BACKUP_ENTRYPOINT = readText('deploy/backup/entrypoint.sh');
const LAUNCHER = readText('deploy/release-launcher.sh');
const GITIGNORE = readText('.gitignore');

function composeService(compose, name) {
  const match = compose.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][\\w-]*:\\n|\\n[a-z]|$)`));
  assert.ok(match, `service ${name} not found`);
  return match[1];
}

test('postgres-exporter exports the wraparound ages the PostgresXidWraparound* alerts read', () => {
  assert.match(composeService(MONITORING_COMPOSE, 'postgres-exporter'), /- --collector\.database_wraparound\b/);
});

test('every Grafana dashboard marks releases from circle_build_info', () => {
  for (const file of ['circle-be.json', 'circle-be-operations.json', 'circle-be-jobs.json', 'circle-be-deliveries.json']) {
    const dashboard = JSON.parse(readText(`monitoring/grafana/dashboards/${file}`));
    const release = dashboard.annotations.list.find((annotation) => annotation.name === '发版');
    assert.ok(release, `${file} has no release annotation`);
    assert.match(release.target.expr, /circle_build_info\{job="circle-be"\}/);
    assert.match(release.target.expr, /\bunless\b.*\boffset\b/, `${file}: the annotation must mark only newly appearing builds`);
  }
});

test('the image build bakes the commit the build info metric reports', () => {
  assert.match(readText('.github/workflows/build-image.yml'), /CIRCLE_BUILD_COMMIT=\$\{\{ github\.sha \}\}/);
  const dockerfile = readText('Dockerfile.prod');
  assert.match(dockerfile, /ARG CIRCLE_BUILD_COMMIT=unknown\nENV CIRCLE_BUILD_COMMIT=\$CIRCLE_BUILD_COMMIT/);
  // 每次提交都变的 ARG 必须在最后一个 RUN 之后，否则每次构建都让依赖层缓存失效。
  assert.ok(dockerfile.lastIndexOf('\nRUN ') < dockerfile.indexOf('ARG CIRCLE_BUILD_COMMIT'));
});

test('the backup scheduler runs the restore drill, and the image tag forces a rebuild', () => {
  assert.match(composeService(BACKUP_COMPOSE, 'backup'), /BACKUP_JOBS: [\w,-]*\bdrill\b/);
  assert.match(BACKUP_ENTRYPOINT, /drill\)\s+printf '%s' "\$\{BACKUP_CRON_DRILL:-[^}]+\}"/);
  // 旧镜像不认识 drill，会在调度器启动时退出：标签必须随之升级。
  assert.match(composeService(BACKUP_COMPOSE, 'backup'), /image: circle-backup:2\n/);
});

test('the synthetic probe runs, is scraped by name and keeps its config across releases', () => {
  const probe = composeService(MONITORING_COMPOSE, 'synthetic-probe');
  assert.match(probe, /- \.\/synthetic-probe\/probe\.mjs:\/probe\/probe\.mjs:ro/);
  assert.match(probe, /path: \.\.\/\.env\.synthetic-probe\n\s+required: false/);
  assert.match(probe, /read_only: true/);
  assert.match(probe, /cap_drop: \[ALL\]/);
  assert.match(MONITORING_COMPOSE, /\nvolumes:\n {2}synthetic_probe_state:\n/);

  const job = PROMETHEUS_PROD.match(/- job_name: synthetic-probe\n([\s\S]*?)(?=\n {2}- job_name:|\n {2}#|$)/);
  assert.ok(job, 'no synthetic-probe scrape job');
  assert.match(job[1], /names: \['synthetic-probe'\]/);
  assert.match(job[1], /port: 9464/);

  // 发版 rsync 只保留排除掉的本机配置：根目录 .env.* 在排除列表里，monitoring/ 下的新文件不在。
  assert.match(LAUNCHER, /--exclude='\/\.env\.\*'/);
  assert.match(GITIGNORE, /^!\.env\.synthetic-probe\.example$/m);
});

const DASHBOARDS = ['circle-be.json', 'circle-be-operations.json', 'circle-be-jobs.json', 'circle-be-deliveries.json'].map(
  (file) => ({ file, value: JSON.parse(readText(`monitoring/grafana/dashboards/${file}`)) }),
);

test('every new metric family is on a dashboard, not only in an alert', () => {
  // 告警响了要能看趋势、看是哪一档：只有告警读、大盘上看不到的指标，排查时只能
  // 去 Prometheus 里手敲查询。
  const joined = DASHBOARDS.flatMap(({ value }) => value.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr))).join('\n');
  for (const metric of [
    'circle_backup_drill_success',
    'circle_backup_drill_last_success_timestamp_seconds',
    'circle_backup_drill_objects_missing',
    'circle_wallet_reconciliation_violations',
    'pg_stat_activity_max_tx_duration',
    'pg_stat_database_deadlocks',
    'pg_database_wraparound_age_datfrozenxid_seconds',
    'circle_call_setups_total',
    'circle_call_accepts_total',
    'circle_call_endings_total',
    'circle_call_answered_duration_seconds',
    'circle_call_livekit_webhooks_total',
    'circle_synthetic_probe_last_success_timestamp_seconds',
    'circle_synthetic_probe_failures_total',
    'circle_build_info',
  ]) {
    assert.match(joined, new RegExp(`\\b${metric}`), `${metric} is not on any dashboard`);
  }
});

test('every dashboard has unique panel ids and a non-overlapping layout', () => {
  for (const { file, value } of DASHBOARDS) {
    const ids = value.panels.map(({ id }) => id);
    assert.equal(new Set(ids).size, ids.length, `${file}: panel ids must be unique`);
    for (let i = 0; i < value.panels.length; i += 1) {
      const a = value.panels[i].gridPos;
      assert.ok(a.x >= 0 && a.y >= 0 && a.w > 0 && a.h > 0 && a.x + a.w <= 24, `${file}: panel ${ids[i]} is off the grid`);
      for (let j = i + 1; j < value.panels.length; j += 1) {
        const b = value.panels[j].gridPos;
        const overlaps = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        assert.equal(overlaps, false, `${file}: panels ${ids[i]} and ${ids[j]} overlap`);
      }
    }
  }
});
