#!/usr/bin/env node
/**
 * 把 Postgres 语句日志（log_min_duration_statement=0、不记参数）按「每条聊天消息」拆开：
 * 以 INSERT ChatMessage 为锚点，统计一个时间窗里各语句的出现次数和库内耗时。
 * 用法：node pg-log-per-message.cjs <pg.log> <窗口开始 HH:MM:SS> <窗口结束 HH:MM:SS> [--timeline N]
 */
const fs = require('node:fs');
const [file, from, to] = process.argv.slice(2);
const timelineIndex = process.argv.includes('--timeline') ? Number(process.argv[process.argv.indexOf('--timeline') + 1]) : null;
const HEAD = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+) UTC \[(\d+)\] (\w+):  (.*)$/;
const entries = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const m = HEAD.exec(line);
  if (m) entries.push({ time: m[2], pid: m[3], text: m[5] });
  else if (entries.length) entries[entries.length - 1].text += ` ${line.trim()}`;
}
const ms = (t) => { const [h, m, s] = t.split(':'); return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000; };
function signature(sql) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/^(BEGIN|COMMIT|ROLLBACK|SET |SHOW |DEALLOCATE)/i.test(s)) return s.split(' ').slice(0, 3).join(' ').slice(0, 40);
  const verb = s.split(' ')[0].toUpperCase();
  const tables = [...new Set([...s.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+(?:"public"\.)?"(\w+)"/g)].map((x) => x[1]))];
  const lock = /FOR (UPDATE|SHARE|NO KEY UPDATE)/i.exec(s);
  return `${verb} ${tables.slice(0, 4).join('+') || s.slice(0, 50)}${lock ? ` [${lock[0]}]` : ''} #${s.length}`;
}
// 一条查询 = parse + bind + execute 三行，合并耗时；简单协议只有 statement 一行。
const queries = [];
const pending = new Map();
for (const e of entries) {
  const m = /^duration: ([\d.]+) ms  (parse|bind|execute|statement)[^:]*: (.*)$/.exec(e.text);
  if (!m) continue;
  const [, dur, phase, sql] = m;
  const key = `${e.pid}`;
  if (phase === 'parse') pending.set(key, { dur: Number(dur), sql });
  else if (phase === 'bind') { const p = pending.get(key) || { dur: 0, sql }; p.dur += Number(dur); pending.set(key, p); }
  else {
    const p = pending.get(key); pending.delete(key);
    queries.push({ t: ms(e.time), time: e.time, pid: e.pid, dbMs: Number(dur) + (p ? p.dur : 0), sig: signature(sql), sql: sql.replace(/\s+/g, ' ') });
  }
}
const inWindow = queries.filter((q) => q.t >= ms(from) && q.t <= ms(to));
const anchors = inWindow.filter((q) => /^INSERT ChatMessage /.test(q.sig));
console.log(`窗口 ${from}–${to}：查询 ${inWindow.length} 条，消息 ${anchors.length} 条，用到的数据库连接 ${new Set(inWindow.map((q) => q.pid)).size} 个`);
if (timelineIndex !== null) {
  const a = anchors[timelineIndex];
  const near = inWindow.filter((q) => q.t >= a.t - 400 && q.t <= a.t + 600);
  for (const q of near) console.log(`${String(Math.round(q.t - a.t)).padStart(5)}ms pid=${q.pid} ${q.dbMs.toFixed(2).padStart(6)}ms ${q.sig}`);
  process.exit(0);
}
const bySig = new Map();
for (const q of inWindow) { const b = bySig.get(q.sig) || { n: 0, total: 0, sample: q.sql }; b.n += 1; b.total += q.dbMs; bySig.set(q.sig, b); }
const rows = [...bySig.entries()].sort((a, b) => b[1].n - a[1].n);
console.log('次数  每条消息  库内合计ms  平均ms  语句');
for (const [sig, b] of rows) console.log(`${String(b.n).padStart(4)}  ${(b.n / anchors.length).toFixed(1).padStart(6)}  ${b.total.toFixed(1).padStart(9)}  ${(b.total / b.n).toFixed(2).padStart(6)}  ${sig}`);
