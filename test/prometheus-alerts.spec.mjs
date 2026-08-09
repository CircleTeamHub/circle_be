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
