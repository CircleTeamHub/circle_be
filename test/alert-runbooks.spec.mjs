import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readText = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');

const RUNBOOK_PATH = 'docs/runbooks/alerts.md';
const RUNBOOK_BASE = `https://github.com/CircleTeamHub/circle_be/blob/main/${RUNBOOK_PATH}#`;
const RULE_FILES = ['monitoring/prometheus/alerts.yml', 'monitoring/loki/rules/fake/circle.yml'];

/**
 * 每条告警的 { name, group, runbookUrl }。按缩进切块：`- name:` 是规则组，
 * `- alert:` 开始一条告警，块内的 runbook_url 属于它。同名告警（同一条规则的
 * 不同档位）各算一条，手册里共用一节。
 */
function rulesIn(path) {
  const rules = [];
  let group;
  let current;
  for (const line of readText(path).split('\n')) {
    const groupMatch = line.match(/^ {2}- name: (\S+)\s*$/);
    if (groupMatch) group = groupMatch[1];
    const alertMatch = line.match(/^\s*- alert: (\w+)\s*$/);
    if (alertMatch) {
      current = { name: alertMatch[1], group, runbookUrl: undefined, file: path };
      rules.push(current);
    }
    const urlMatch = line.match(/^\s*runbook_url: (\S+)\s*$/);
    if (urlMatch && current) current.runbookUrl = urlMatch[1];
  }
  return rules;
}

const RULES = RULE_FILES.flatMap(rulesIn);
const RUNBOOK = readText(RUNBOOK_PATH);

/** 手册里每个 `### 告警名` 小节：所在的 `## 分组` 与正文。 */
function runbookEntries() {
  const entries = [];
  let group;
  let current;
  for (const line of RUNBOOK.split('\n')) {
    const groupMatch = line.match(/^## (.+?)\s*$/);
    if (groupMatch) {
      group = groupMatch[1];
      current = undefined;
      continue;
    }
    const entryMatch = line.match(/^### (.+?)\s*$/);
    if (entryMatch) {
      current = { name: entryMatch[1], group, body: '' };
      entries.push(current);
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  return entries;
}

const ENTRIES = runbookEntries();

test('the rule files are parsed (guards the parser itself)', () => {
  assert.ok(RULES.length >= 80, `only ${RULES.length} alerts parsed`);
  assert.ok(RULES.every((rule) => rule.group), 'an alert outside any rule group');
});

test('every alert links to its own runbook section', () => {
  for (const rule of RULES) {
    assert.equal(
      rule.runbookUrl,
      `${RUNBOOK_BASE}${rule.name.toLowerCase()}`,
      `${rule.file}: ${rule.name} must carry runbook_url pointing at its section`,
    );
  }
});

test('every alert has exactly one runbook section, under its own rule group', () => {
  for (const name of new Set(RULES.map((rule) => rule.name))) {
    const matches = ENTRIES.filter((entry) => entry.name === name);
    assert.equal(matches.length, 1, `${RUNBOOK_PATH} needs exactly one "### ${name}" (found ${matches.length})`);
    const groups = new Set(RULES.filter((rule) => rule.name === name).map((rule) => rule.group));
    assert.ok(groups.has(matches[0].group), `### ${name} sits under "## ${matches[0].group}", want one of ${[...groups].join(', ')}`);
  }
});

test('the runbook has no sections for alerts that no longer exist', () => {
  const names = new Set(RULES.map((rule) => rule.name));
  for (const entry of ENTRIES) {
    assert.ok(names.has(entry.name), `### ${entry.name} has no matching alert — remove it or rename it with the rule`);
  }
});

test('every runbook section says what fired, what to look at and what to do', () => {
  for (const entry of ENTRIES) {
    for (const marker of ['**含义**：', '**先看**：', '**常见原因与处置**：']) {
      assert.ok(entry.body.includes(marker), `### ${entry.name} is missing ${marker}`);
    }
  }
});

test('anchors are predictable: section headings are bare ASCII alert names', () => {
  for (const entry of ENTRIES) {
    assert.match(entry.name, /^[A-Za-z0-9]+$/, `### ${entry.name} would not produce the #${entry.name.toLowerCase()} anchor`);
  }
});
