#!/usr/bin/env node
/**
 * 后端聊天压测的发压端：模拟 N 个在线用户，各自保持一条长连接，按固定间隔发文本消息，
 * 同时偶尔拉一次会话列表。统计连接、发送确认（ack）和投递的延迟。
 *
 * 直连后端容器（经 SSH 隧道），不走 Caddy：Caddy 的限流按来源 IP 算，从一台机器发压只会测到限流。
 * 每个虚拟用户带自己的转发地址头，让后端按「每人一个 IP」做限流，和真实分布一致。
 *
 * 用法：
 *   PERF_CLIENT_ROOT=<前端仓库检出> node load-chat.cjs --url http://127.0.0.1:13100 \
 *     --accounts <令牌文件> --users 100 --interval-ms 5000 --duration-s 120 --ramp-s 20 --label step-100
 *
 * --url 给多个地址（逗号分隔）时用户轮流连各实例；--offset 让多个发压进程各取一段账号。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
// 后端仓库不依赖 socket.io-client：从一个装了它的目录借（通常是前端仓库的检出）。
const CLIENT_ROOT = opt('--client-root', process.env.PERF_CLIENT_ROOT);
if (!CLIENT_ROOT) throw new Error('需要 --client-root 或 PERF_CLIENT_ROOT：一个 node_modules 里有 socket.io-client 的目录');
const { io } = createRequire(path.join(CLIENT_ROOT, 'package.json'))('socket.io-client');

// --url 可以给多个地址(逗号分隔):第 i 个虚拟用户连第 i % N 个,用来压多实例。
const URLS = String(opt('--url', '')).split(',').filter(Boolean);
const OFFSET = Number(opt('--offset', '0')); // 从令牌文件的第几个账号开始取(多个发压进程分片用)
const ACCOUNTS_FILE = opt('--accounts');
const USERS = Number(opt('--users', '10'));
const INTERVAL_MS = Number(opt('--interval-ms', '5000'));
const DURATION_S = Number(opt('--duration-s', '60'));
const RAMP_S = Number(opt('--ramp-s', '10'));
const LIST_EVERY_S = Number(opt('--list-every-s', '30'));
const GROUP_SHARE = Number(opt('--group-share', '0.3')); // 发到群里的消息比例
const LABEL = opt('--label', `users-${USERS}`);
const ACK_TIMEOUT_MS = 10_000;
if (URLS.length === 0 || !ACCOUNTS_FILE) throw new Error('需要 --url 和 --accounts');

const RUN = `LOAD-${Date.now().toString(36)}`;
const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')).slice(OFFSET, OFFSET + USERS);
if (accounts.length < USERS) throw new Error(`令牌文件里只有 ${accounts.length} 个账号`);

const stats = {
  connectMs: [], connectFailed: 0, disconnects: 0, disconnectReasons: {},
  sent: 0, ackOk: 0, ackError: 0, ackTimeout: 0, ackMs: [], ackErrorCodes: {},
  delivered: 0, deliveryMs: [],
  listOk: 0, listFailed: 0, listMs: [], listStatus: {},
};
const bump = (bag, key) => { bag[key] = (bag[key] || 0) + 1; };
const pct = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
};
const summary = (values) => ({ n: values.length, p50: pct(values, 50), p95: pct(values, 95), p99: pct(values, 99) });

let stopping = false;
const sockets = [];
const timers = [];

function fakeIp(index) {
  return `10.${1 + Math.floor(index / 62500)}.${Math.floor(index / 250) % 250}.${(index % 250) + 1}`;
}

function startUser(account, index) {
  const ip = fakeIp(OFFSET + index);
  const URL_BASE = URLS[(OFFSET + index) % URLS.length];
  const directs = account.conversations.filter((c) => c.kind === 'DIRECT').map((c) => c.id);
  const groups = account.conversations.filter((c) => c.kind === 'GROUP').map((c) => c.id);
  const mine = new Set();
  const startedAt = Date.now();
  const socket = io(URL_BASE, {
    path: '/chat-ws',
    transports: ['websocket'],
    auth: { token: account.accessToken },
    extraHeaders: { 'X-Forwarded-For': ip },
    reconnection: false,
    timeout: 20_000,
  });
  sockets.push(socket);
  let sequence = 0;

  socket.on('connect', () => {
    stats.connectMs.push(Date.now() - startedAt);
    const send = () => {
      if (stopping || !socket.connected) return;
      const pool = groups.length && (Math.random() < GROUP_SHARE || !directs.length) ? groups : directs;
      if (!pool.length) return;
      const conversationId = pool[Math.floor(Math.random() * pool.length)];
      sequence += 1;
      const text = `${RUN}-${Date.now()}-${index}-${sequence}`;
      mine.add(text);
      const sentAt = Date.now();
      stats.sent += 1;
      socket.timeout(ACK_TIMEOUT_MS).emit(
        'chat:send',
        { conversationId, type: 'text', content: { text }, d: crypto.randomUUID() },
        (error, ack) => {
          if (error) { stats.ackTimeout += 1; return; }
          if (ack && ack.ok) { stats.ackOk += 1; stats.ackMs.push(Date.now() - sentAt); return; }
          stats.ackError += 1;
          bump(stats.ackErrorCodes, String(ack && ack.code));
        },
      );
    };
    // 起始相位错开，避免所有人同一时刻发。
    timers.push(setTimeout(() => {
      send();
      timers.push(setInterval(send, INTERVAL_MS));
    }, Math.random() * INTERVAL_MS));

    const list = async () => {
      if (stopping) return;
      const t0 = Date.now();
      try {
        const response = await fetch(`${URL_BASE}/api/v1/chat/conversations?limit=500`, {
          headers: { Authorization: `Bearer ${account.accessToken}`, 'X-Forwarded-For': ip },
        });
        await response.arrayBuffer();
        bump(stats.listStatus, String(response.status));
        if (response.ok) { stats.listOk += 1; stats.listMs.push(Date.now() - t0); } else stats.listFailed += 1;
      } catch { stats.listFailed += 1; bump(stats.listStatus, 'network'); }
    };
    timers.push(setTimeout(() => {
      void list();
      timers.push(setInterval(list, LIST_EVERY_S * 1000));
    }, Math.random() * LIST_EVERY_S * 1000));
  });

  socket.on('chat:msg', (message) => {
    const text = message && message.content && message.content.text;
    if (typeof text !== 'string' || !text.startsWith(`${RUN}-`) || mine.has(text)) return;
    const sentAt = Number(text.split('-')[2]);
    if (Number.isFinite(sentAt)) { stats.delivered += 1; stats.deliveryMs.push(Date.now() - sentAt); }
  });
  socket.on('connect_error', (error) => { stats.connectFailed += 1; bump(stats.disconnectReasons, `connect_error:${error.message}`); });
  socket.on('disconnect', (reason) => { if (!stopping) { stats.disconnects += 1; bump(stats.disconnectReasons, reason); } });
}

async function main() {
  const perUserDelay = (RAMP_S * 1000) / USERS;
  accounts.forEach((account, index) => timers.push(setTimeout(() => startUser(account, index), index * perUserDelay)));
  const progress = setInterval(() => {
    const connected = sockets.filter((s) => s.connected).length;
    process.stderr.write(`[${LABEL}] 在线 ${connected}/${USERS} 已发 ${stats.sent} 确认 ${stats.ackOk} 超时 ${stats.ackTimeout} 错误 ${stats.ackError}\n`);
  }, 15_000);
  await new Promise((resolve) => setTimeout(resolve, (RAMP_S + DURATION_S) * 1000));
  stopping = true;
  const connectedAtEnd = sockets.filter((s) => s.connected).length;
  clearInterval(progress);
  timers.forEach((timer) => { clearTimeout(timer); clearInterval(timer); });
  // 留出确认预算，再断开。
  await new Promise((resolve) => setTimeout(resolve, 4000));
  sockets.forEach((socket) => socket.close());
  const result = {
    label: LABEL, users: USERS, intervalMs: INTERVAL_MS, durationS: DURATION_S,
    targetMsgPerSec: Number((USERS / (INTERVAL_MS / 1000)).toFixed(1)),
    connectedAtEnd, connectFailed: stats.connectFailed, disconnects: stats.disconnects,
    disconnectReasons: stats.disconnectReasons, connect: summary(stats.connectMs),
    sent: stats.sent, ackOk: stats.ackOk, ackError: stats.ackError, ackTimeout: stats.ackTimeout,
    ackErrorCodes: stats.ackErrorCodes,
    ackFailRate: stats.sent ? Number((((stats.ackError + stats.ackTimeout) / stats.sent) * 100).toFixed(2)) : 0,
    ack: summary(stats.ackMs), delivered: stats.delivered, delivery: summary(stats.deliveryMs),
    list: { ok: stats.listOk, failed: stats.listFailed, status: stats.listStatus, ...summary(stats.listMs) },
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  setTimeout(() => process.exit(0), 500);
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exit(1); });
