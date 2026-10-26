import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// 投递、依赖与业务大盘：前几批加的计数器（推送、验证码邮件、对象存储与 LiveKit、
// 业务事件、上传、漏网 rejection）此前只有告警读，没有任何地方能看趋势。
const ROOT = join(import.meta.dirname, '..');
const PATH = join(ROOT, 'monitoring/grafana/dashboards/circle-be-deliveries.json');
const dashboard = () => JSON.parse(readFileSync(PATH, 'utf8'));
const RULES = readFileSync(join(ROOT, 'monitoring/prometheus/alerts.yml'), 'utf8');

test('deliveries dashboard has a stable identity and a valid non-overlapping layout', () => {
  const value = dashboard();
  assert.equal(value.uid, 'circle-be-deliveries');
  assert.match(value.title, /Deliveries/);
  assert.deepEqual(value.templating.list, []);
  const ids = value.panels.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, 'panel IDs must be unique');
  for (const panel of value.panels) {
    const { x, y, w, h } = panel.gridPos;
    assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 24);
  }
  for (let i = 0; i < value.panels.length; i += 1) {
    for (let j = i + 1; j < value.panels.length; j += 1) {
      const a = value.panels[i].gridPos;
      const b = value.panels[j].gridPos;
      const overlaps = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      assert.equal(overlaps, false, `panels ${value.panels[i].id} and ${value.panels[j].id} overlap`);
    }
  }
});

test('every panel uses the provisioned Prometheus datasource and explains itself', () => {
  for (const panel of dashboard().panels) {
    assert.deepEqual(panel.datasource, { type: 'prometheus', uid: 'prometheus' });
    assert.ok(panel.description?.trim(), `${panel.title} needs an operator description`);
    assert.ok(panel.targets.length > 0, `${panel.title} needs a query`);
    for (const target of panel.targets) {
      assert.deepEqual(target.datasource, { type: 'prometheus', uid: 'prometheus' });
      assert.ok(target.expr?.trim());
      assert.ok(target.legendFormat?.trim());
    }
  }
});

test('queries cover every delivery, dependency and business counter', () => {
  const joined = dashboard().panels.flatMap((p) => p.targets.map((t) => t.expr)).join('\n');
  for (const metric of [
    'circle_push_deliveries_total',
    'circle_email_code_sends_total',
    'circle_dependency_requests_total',
    'circle_object_store_up',
    'business_events_total',
    'upload_presign_requests_total',
    'upload_presign_rate_limited_total',
    'circle_unhandled_rejections_total',
  ]) {
    assert.match(joined, new RegExp(metric), `${metric} is not on the dashboard`);
  }
  // 与告警同一口径：失效 token 不算推送失败、可达性探测不进依赖失败率。
  const push = dashboard().panels.find(({ title }) => /Push failure ratio/.test(title));
  assert.ok(push, 'no push failure ratio panel');
  assert.match(push.targets[0].expr, /result=~"retryable\|rejected"/);
  assert.doesNotMatch(push.targets[0].expr, /dead_token/);
  const dependency = dashboard().panels.find(({ title }) => /Dependency failure ratio/.test(title));
  assert.ok(dependency, 'no dependency failure ratio panel');
  assert.equal([...dependency.targets[0].expr.matchAll(/operation!="HeadBucket"/g)].length, 2);
  assert.match(RULES, /operation!="HeadBucket"/);
});

test('ratio stats show no data, not NaN, when nothing was sent', () => {
  // 计数器启动时 inc(0) 预先建好序列，没有发送时 0/0 = NaN，而 stat 面板会把 NaN
  // 按最低档（绿色）画出来 —— 看上去一切正常。分母为 0 时要让查询结果为空。
  for (const panel of dashboard().panels.filter(({ type }) => type === 'stat')) {
    for (const { expr } of panel.targets) {
      if (!/\)\s*\/\s*sum/.test(expr)) continue;
      assert.match(expr, /\band\b[\s\S]*\)\s*>\s*0\s*$/, `stat panel ${panel.id} divides without guarding a zero denominator`);
    }
  }
});
