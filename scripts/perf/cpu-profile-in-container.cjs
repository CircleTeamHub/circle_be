#!/usr/bin/env node
/**
 * 在后端容器里跑：连本进程组里已打开的 Node 调试口（先对后端进程发 SIGUSR1），
 * 采一段主线程 CPU 剖析写到 /tmp/cpu.cpuprofile，然后把调试口关掉。
 * 用法：node cpu-profile-in-container.cjs <秒数>
 */
const seconds = Number(process.argv[2] || 30);
(async () => {
  const targets = await (await fetch('http://127.0.0.1:9229/json')).json();
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('调试口连不上')); });
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 500 });
  await send('Profiler.start');
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const { profile } = await send('Profiler.stop');
  require('node:fs').writeFileSync('/tmp/cpu.cpuprofile', JSON.stringify(profile));
  console.log(`已写出剖析：节点 ${profile.nodes.length} 个，采样 ${profile.samples.length} 次`);
  send('Runtime.evaluate', { expression: 'process._debugEnd()' }).catch(() => {});
  setTimeout(() => process.exit(0), 1000);
})().catch((error) => { console.error(error.message); process.exit(1); });
