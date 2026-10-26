import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const LAUNCHER = read('deploy/release-launcher.sh');
const DEPLOY = read('DEPLOY.md');

/**
 * 发布树用 `rsync --delete` 同步（发版 launcher，以及 DEPLOY.md 里首次上传的那条）。
 * 服务器本机生成的配置不在仓库里，没被排除就会在每次同步时被删掉 —— 旧 launcher
 * 就这样删了 `.env.backup` 和监控栈的密钥，发版后重建备份 / 监控栈随即失败。
 * 这里以各目录的 .gitignore 为准：新增一个本机配置文件，两处 rsync 都必须跟上。
 */

// rsync 过滤规则：按出现顺序，第一条匹配的生效。
function rsyncRules(text, flagPattern) {
  return [...text.matchAll(flagPattern)].map((m) => ({ kind: m[1], pattern: m[3] }));
}

function globToRegExp(pattern) {
  const anchored = pattern.startsWith('/');
  const body = pattern
    .replace(/^\//, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  // 不以 / 开头的规则匹配任意一级路径（rsync 的语义）。
  return new RegExp(anchored ? `^/${body}$` : `(^|/)${body}$`);
}

function verdict(rules, path) {
  const rule = rules.find(({ pattern }) => globToRegExp(pattern).test(path));
  return rule ? rule.kind : 'include';
}

const LAUNCHER_RULES = rsyncRules(LAUNCHER, /--(include|exclude)=('?)([^'\s\\]+)\2/g);
const deployBlock = DEPLOY.match(/```bash\nrsync -az --delete \\\n([\s\S]*?)```/);
const MANUAL_RULES = deployBlock
  ? rsyncRules(deployBlock[1], /--(include|exclude) ('?)([^'\s\\]+)\2/g)
  : [];

// 各 .gitignore 里「只存在于服务器上」的文件，按 rsync 的绝对路径给出。glob
// 用一个具体文件名代入（`*.yml` → `x.yml`）。根目录的 .gitignore 大多是开发产物
// （node_modules、dist…，另有排除规则），只取其中的 `.env*`；子目录的 .gitignore
// 本来就只为本机配置而设，全部算上 —— 新增一个就会被这里看见。
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.claude', 'logs', '.release']);

function nestedGitignores(dir = ROOT) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...nestedGitignores(join(dir, entry.name)));
    } else if (entry.name === '.gitignore' && dir !== ROOT) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

function patterns(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
}

function hostLocalPaths() {
  const paths = patterns(join(ROOT, '.gitignore'))
    .filter((pattern) => /^\/?\.env/.test(pattern))
    .map((pattern) => `/${pattern.replace(/^\//, '').replace(/\*/g, 'x')}`);
  for (const file of nestedGitignores()) {
    const dir = dirname(file).slice(ROOT.length);
    for (const pattern of patterns(file)) {
      paths.push(`${dir}/${pattern.replace(/^\//, '').replace(/\*/g, 'x')}`);
    }
  }
  return paths;
}

const HOST_LOCAL = hostLocalPaths();

test('the host-local file list covers the monitoring secrets', () => {
  for (const path of [
    '/.env',
    '/.env.x',
    '/monitoring/.env',
    '/monitoring/.env.exporters',
    '/monitoring/alertmanager/discord.url',
    '/monitoring/prometheus/metrics_token',
    '/monitoring/prometheus/probe-targets/x.yml',
  ]) {
    assert.ok(HOST_LOCAL.includes(path), `${path} missing from the derived list`);
  }
});

for (const [name, rules] of [
  ['the release launcher', LAUNCHER_RULES],
  ['the manual rsync in DEPLOY.md', MANUAL_RULES],
]) {
  test(`${name} keeps every host-local file`, () => {
    assert.ok(rules.length > 0, `no rsync filter rules found in ${name}`);
    for (const path of HOST_LOCAL) {
      assert.equal(verdict(rules, path), 'exclude', `${name} would delete ${path}`);
    }
  });

  test(`${name} still ships the tracked templates and state is untouched`, () => {
    for (const path of [
      '/.env.example',
      '/.env.backup.example',
      '/.env.production.example',
      '/monitoring/.env.example',
      '/monitoring/alertmanager/discord.url.example',
      '/monitoring/prometheus/probe-targets/public.yml.example',
      '/monitoring/prometheus/alerts.yml',
    ]) {
      assert.equal(verdict(rules, path), 'include', `${name} would not update ${path}`);
    }
    assert.equal(verdict(rules, '/.release'), 'exclude');
    assert.equal(verdict(rules, '/logs'), 'exclude');
  });
}

test('the launcher restores checkout modes without ever opening the tree root', () => {
  // 暂存目录被 force command 收成 go-rwx；监控容器以自己的用户读挂载的配置，所以
  // 内容要恢复成 0755/0644。但根目录必须始终私有：rsync --chmod 会连根目录一起
  // 放开，整个传输期间（以及传输失败后）本机其他账号都能读到 0644 的本机密钥。
  const rsync = LAUNCHER.indexOf('rsync -a --delete');
  const command = LAUNCHER.slice(rsync, LAUNCHER.indexOf('"$STAGED_RELEASE/" "$DEPLOY_ROOT/"', rsync));
  assert.doesNotMatch(command, /--chmod/);
  const before = LAUNCHER.slice(0, rsync);
  assert.match(before, /\nchmod go-rwx "\$DEPLOY_ROOT"\n/);
  assert.match(before, /\nfind "\$STAGED_RELEASE" -mindepth 1 .*-type d -exec chmod go\+rx .*-type f -exec chmod go\+rX /);
  assert.match(before, /\nchmod go-rwx "\$STAGED_RELEASE"\n/);
  assert.match(LAUNCHER, /RELEASE_LAUNCHER_KEEPS_HOST_CONFIG=1/);
});
