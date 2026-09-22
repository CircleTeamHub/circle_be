import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
const ROOT = join(import.meta.dirname, '..');
const DASHBOARD_PATH = join(ROOT, 'monitoring/grafana/dashboards/circle-be-operations.json');
const dashboard = () => JSON.parse(readFileSync(DASHBOARD_PATH, 'utf8'));
test('operations dashboard has a stable identity and valid non-overlapping layout', () => {
  const value = dashboard();
  assert.equal(value.uid, 'circle-be-operations');
  assert.match(value.title, /Operations/);
  assert.deepEqual(value.templating.list, []);
  assert.ok(value.panels.length >= 8);
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
test('every panel and query uses the provisioned Prometheus datasource', () => {
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
test('queries cover alerts, target health, alert delivery, probes, and host capacity', () => {
  const expressions = dashboard().panels.flatMap((panel) => panel.targets.map(({ expr }) => expr));
  const joined = expressions.join('\n');
  for (const metric of [
    'ALERTS', 'up', 'alertmanager_notifications_failed_total', 'alertmanager_config_last_reload_successful',
    'prometheus_rule_evaluation_failures_total', 'probe_success', 'probe_ssl_earliest_cert_expiry',
    'node_memory_MemAvailable_bytes', 'node_memory_MemTotal_bytes', 'node_filesystem_avail_bytes',
    'node_filesystem_size_bytes', 'node_filesystem_readonly', 'loki_write_batch_retries_total',
    'loki_write_dropped_entries_total',
  ]) {
    assert.match(joined, new RegExp(metric));
  }

  assert.doesNotMatch(joined, /or\s+(?:on\s*\([^)]*\)\s*)?vector\s*\(\s*1\s*\)/);
  assert.match(joined, /ALERTS\{alertstate="firing",alertname!="Watchdog"\}/);
  assert.match(joined, /increase\(alertmanager_notifications_failed_total\[10m\]\)/);
  assert.match(joined, /increase\(prometheus_rule_evaluation_failures_total\[10m\]\)/);
  assert.match(joined, /probe_ssl_earliest_cert_expiry[^\n]*- time\(\)/);
  assert.match(joined, /fstype=~"ext4\|xfs\|btrfs\|zfs\|ext3"/);
  assert.match(joined, /node_filesystem_readonly == 0/);
});
test('optional Alloy delivery rates stay absent rather than looking healthy', () => {
  const value = dashboard();
  const alloyPanel = value.panels.find(({ title }) => /Alloy.*retry.*drop/i.test(title));
  assert.ok(alloyPanel, 'dashboard needs an Alloy retry/drop rate panel');
  assert.equal(alloyPanel.fieldConfig.defaults.unit, 'ops');
  assert.match(alloyPanel.description, /optional/i);
  assert.match(alloyPanel.description, /No data/);
  assert.deepEqual(alloyPanel.targets.map(({ legendFormat }) => legendFormat), ['retries', 'dropped entries']);
  assert.doesNotMatch(alloyPanel.targets.map(({ expr }) => expr).join('\n'), /or\s+(?:on\s*\([^)]*\)\s*)?vector/);
});
test('host panels describe node_exporter as part of the base stack', () => {
  const descriptions = dashboard().panels.filter(({ title }) => /Host memory|host filesystem/.test(title))
    .map(({ description }) => description).join('\n');
  assert.doesNotMatch(descriptions, /production-only/i);
  assert.match(descriptions, /base monitoring stack/i);
});

test('descriptions do not overstate notification receipt and explain absent optional data', () => {
  const descriptions = dashboard().panels.map(({ description }) => description).join('\n');
  assert.match(descriptions, /attempt|delivery/i);
  assert.match(descriptions, /does not prove|cannot prove/i);
  assert.match(descriptions, /No data/);
  assert.match(descriptions, /optional|production/i);
});
