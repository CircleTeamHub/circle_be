#!/usr/bin/env node
/**
 * 汇总 V8 .cpuprofile：按「代码归属」统计自身耗时，并列出自身耗时最高的函数、
 * 以及几个关键入口的累计耗时（含子调用）。
 * 用法：node cpuprofile-summary.cjs <file.cpuprofile> [累计耗时要看的函数名正则]
 */
const fs = require('node:fs');
const profile = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const inclusiveRe = process.argv[3] ? new RegExp(process.argv[3]) : null;
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
profile.samples.forEach((id, i) => self.set(id, (self.get(id) || 0) + (profile.timeDeltas[i] || 0)));
const total = [...self.values()].reduce((a, b) => a + b, 0);
function owner(frame) {
  const url = frame.url || '';
  const fn = frame.functionName;
  if (fn === '(idle)') return '空闲';
  if (fn === '(garbage collector)') return '垃圾回收';
  if (fn === '(program)') return '(program) 原生/系统调用';
  const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(url);
  if (pkg) return `依赖 ${pkg[1]}`;
  if (url.startsWith('node:')) return `Node 内置 ${url.split('/')[0]}`;
  if (url.includes('/dist/')) return `业务代码 ${url.replace(/.*\/dist\/src\//, '').split('/')[0]}`;
  return url ? `其它 ${url.slice(0, 40)}` : '(无来源) 原生';
}
const byOwner = new Map();
const byFn = new Map();
for (const [id, t] of self) {
  const f = nodes.get(id).callFrame;
  const o = owner(f);
  byOwner.set(o, (byOwner.get(o) || 0) + t);
  const key = `${f.functionName || '(anonymous)'} — ${(f.url || '').replace(/.*node_modules\//, '').replace(/.*\/dist\/src\//, 'src/')}:${f.lineNumber}`;
  byFn.set(key, (byFn.get(key) || 0) + t);
}
const idle = byOwner.get('空闲') || 0;
const busy = total - idle;
const pct = (t) => `${((t / busy) * 100).toFixed(1).padStart(5)}%`;
console.log(`总时长 ${(total / 1e6).toFixed(1)}s，忙碌 ${(busy / 1e6).toFixed(1)}s（${((busy / total) * 100).toFixed(0)}%）。下面的百分比都是占忙碌时间。`);
console.log('\n== 按归属（自身耗时）');
[...byOwner.entries()].filter(([o]) => o !== '空闲').sort((a, b) => b[1] - a[1]).slice(0, 28)
  .forEach(([o, t]) => console.log(`${pct(t)}  ${(t / 1e3).toFixed(0).padStart(6)}ms  ${o}`));
console.log('\n== 自身耗时最高的函数');
[...byFn.entries()].filter(([k]) => !k.startsWith('(idle)')).sort((a, b) => b[1] - a[1]).slice(0, 30)
  .forEach(([k, t]) => console.log(`${pct(t)}  ${k.slice(0, 130)}`));
if (inclusiveRe) {
  // 累计耗时：对每个匹配的节点，把整棵子树的自身耗时加起来；同名函数嵌套时只算最外层。
  const subtree = (node) => (self.get(node.id) || 0) + (node.children || []).reduce((sum, c) => sum + subtree(nodes.get(c)), 0);
  const inclusive = new Map();
  const walk = (node, inside) => {
    const name = node.callFrame.functionName;
    const hit = inclusiveRe.test(name) && !inside.has(name);
    if (hit) inclusive.set(name, (inclusive.get(name) || 0) + subtree(node));
    const next = hit ? new Set([...inside, name]) : inside;
    (node.children || []).forEach((c) => walk(nodes.get(c), next));
  };
  walk(profile.nodes[0], new Set());
  console.log('\n== 累计耗时（含子调用）');
  [...inclusive.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).forEach(([k, t]) => console.log(`${pct(t)}  ${k}`));
}
