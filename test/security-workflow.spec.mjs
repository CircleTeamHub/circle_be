import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const SECURITY = read('.github/workflows/security.yml');
const BUILD = read('.github/workflows/build-image.yml');

function job(name) {
  const match = SECURITY.match(new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[a-z][\\w-]*:\\n|$)`));
  assert.ok(match, `no ${name} job in security.yml`);
  return match[1];
}

/**
 * 新漏洞每天都在出。此前定时扫描一周一次、只扫 npm 依赖，已经发布的镜像在合并那一刻
 * 扫过之后就没人再看 —— body-parser 的高危是某个无关 PR 碰巧撞上才发现的。
 */
test('security scans run daily and on demand', () => {
  assert.match(SECURITY, /\n {2}schedule:\n\s*(#.*\n\s*)*- cron: "0 6 \* \* \*"/);
  assert.match(SECURITY, /\n {2}workflow_dispatch:\n/);
});

test('the published images are re-scanned with the build-time verdict rules', () => {
  const scan = job('published-image-scan');
  // PR 上已经扫它自己构建的镜像；这里只看已经发布出去的。
  assert.match(scan, /if: \$\{\{ github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \}\}/);
  assert.match(scan, /packages: read/);
  assert.match(scan, /main=\$repo:main-\$arch/);
  // 先登录再解析：判断 tag 有没有镜像要读 GHCR。
  assert.ok(scan.indexOf('- name: Login to GHCR') < scan.indexOf('- name: Resolve published images'));
  const buildScan = BUILD.match(/- name: Scan releasable image\n[\s\S]*?exit-code: "1"/)[0];
  for (const setting of ['scanners: vuln', 'severity: HIGH,CRITICAL', 'ignore-unfixed: true', 'trivyignores: .trivyignore']) {
    assert.ok(buildScan.includes(setting), `build-image.yml no longer uses ${setting}`);
    assert.equal(
      scan.split(setting).length - 1,
      2,
      `both published-image scans must use ${setting}, like the build-time scan`,
    );
  }
  // 发布镜像的平台与构建时一致，否则扫的不是线上跑的那份。
  assert.match(scan, /RELEASE_PLATFORM: \$\{\{ vars\.RELEASE_PLATFORM \|\| 'linux\/arm64' \}\}/);
  // 第一个镜像有漏洞时，第二个照样要扫。
  assert.match(scan, /- name: Scan latest release image\n\s*if: \$\{\{ always\(\) && /);
});

test('a failed scheduled scan reaches Discord', () => {
  const notify = job('notify');
  for (const name of ['secret-scan', 'dependency-audit', 'published-image-scan']) {
    assert.match(notify, new RegExp(`\\n\\s*- ${name}\\n`), `notify does not wait for ${name}`);
  }
});

test('scheduled runs do not share a concurrency group with pushes to main', () => {
  // 定时和手动触发的 ref 也是 main；共用一个组时，任何一次合并都会把当天的扫描取消掉。
  assert.match(SECURITY, /\nconcurrency:\n\s*group: security-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}\n/);
  // 被新运行取代的那次不发 Discord。
  assert.match(job('notify'), /if: \$\{\{ !cancelled\(\) && /);
});

test('the release image is the newest strict vX.Y.Z tag that has a published image', () => {
  const scan = job('published-image-scan');
  const step = scan.match(/- name: Resolve published images\n[\s\S]*?run: \|\n([\s\S]*?)(?=\n\s*- name: |$)/);
  assert.ok(step, 'no resolve step');
  const script = step[1]
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
    .replace(/\$\{\{[^}]*\}\}/g, '');
  const dir = mkdtempSync(join(tmpdir(), 'circle-security-scan-'));
  try {
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x');
    // git 的 v:refname 会把 v1beta、-rc 排在 v1.2.10 之上；v1.2.10 发版失败没有镜像。
    for (const tag of ['v1.2.8', 'v1.2.9', 'v1.2.10', 'v1.2.10-rc.2', 'v1beta']) git('tag', tag);
    const bin = join(dir, 'bin');
    spawnSync('mkdir', [bin]);
    writeFileSync(
      join(bin, 'docker'),
      // 预发布和非语义化 tag 即使有镜像也不算正式版。
      '#!/usr/bin/env bash\ncase "$*" in *":v1.2.9-arm64"*|*":v1.2.8-arm64"*|*":v1beta-arm64"*|*":v1.2.10-rc.2-arm64"*) exit 0 ;; esac\nexit 1\n',
    );
    chmodSync(join(bin, 'docker'), 0o755);
    const output = join(dir, 'out');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RELEASE_PLATFORM: 'linux/arm64',
        GITHUB_REPOSITORY: 'CircleTeamHub/circle_be',
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(output, 'utf8').trim().split('\n');
    assert.deepEqual(lines, [
      'main=ghcr.io/circleteamhub/circle_be:main-arm64',
      'release=ghcr.io/circleteamhub/circle_be:v1.2.9-arm64',
    ]);
    assert.match(result.stdout, /v1\.2\.10 has no published arm64 image/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
