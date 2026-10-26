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
