import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  createMetricsServer,
  createProbe,
  escapeLabelValue,
  loadConfig,
} from '../monitoring/synthetic-probe/probe.mjs';

/**
 * 合成探针是生产告警的数据源：它判错（把后端故障当成功，或把自己的问题当成后端故障）都会
 * 直接变成漏报或误报。这里用 node:http + ws 起一个假后端，按服务端真实契约（统一包裹
 * { code, message, data }、refresh 单次轮换、无 Origin 握手、badge.snapshot 即就绪）走真实的
 * fetch 和全局 WebSocket，而不是 mock 掉网络层。
 */

const DEVICE_ID = 'probe-device-0123456789';
const IDENTIFIER = 'probe-account@example.test';
const PASSWORD = 'pr0be-very-secret-pass';
const P = 'circle_synthetic_probe_';
const LOGIN = '/api/v1/auth/login';
const REFRESH = '/api/v1/auth/refresh';
const CONVERSATIONS = '/api/v1/chat/conversations';

function makeJwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature`;
}

function within(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sample(text, series) {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

async function startBackend() {
  const state = {
    login: 'ok', // ok | device | reject
    refresh: 'ok', // ok | destroy
    api: 'ok', // ok | 401 | hang
    ws: 'snapshot', // snapshot | close1008 | silent
    onConversations: null,
  };
  const requests = [];
  const connections = [];
  const issued = [];
  const validAccess = new Set();
  const validRefresh = new Set();

  const issue = (exp = Math.floor(Date.now() / 1000) + 3600) => {
    const n = issued.length + 1;
    const pair = { accessToken: makeJwt({ sub: 'probe-user', exp, n }), refreshToken: `refresh-${n}`, exp };
    issued.push(pair);
    validAccess.add(pair.accessToken);
    validRefresh.add(pair.refreshToken);
    return pair;
  };
  const send = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: status < 400 ? 0 : status, message: status < 400 ? 'ok' : 'error', data }));
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const entry = { method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    requests.push(entry);
    if (req.method === 'POST' && req.url === LOGIN) {
      // 与后端一致：密码错回 403 InvalidCredentials。
      if (state.login === 'reject') return send(res, 403, null);
      if (state.login === 'device') {
        return send(res, 201, { deviceVerificationRequired: true, challenge: { id: 'challenge-1' } });
      }
      const { accessToken, refreshToken } = issue();
      return send(res, 201, { accessToken, refreshToken });
    }
    if (req.method === 'POST' && req.url === REFRESH) {
      if (state.refresh === 'destroy') return req.socket.destroy();
      if (!validRefresh.delete(entry.body?.refreshToken)) return send(res, 401, null);
      const { accessToken, refreshToken } = issue();
      return send(res, 201, { accessToken, refreshToken });
    }
    if (req.method === 'GET' && req.url === CONVERSATIONS) {
      state.onConversations?.(entry);
      if (state.api === 'hang') return undefined;
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (state.api === '401' || !validAccess.has(token)) return send(res, 401, null);
      return send(res, 200, [{ conversationID: 'c1' }]);
    }
    return send(res, 404, null);
  });

  const wss = new WebSocketServer({ server, path: '/realtime' });
  wss.on('connection', (socket, req) => {
    const conn = { headers: req.headers, frames: [] };
    conn.closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)));
    connections.push(conn);
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      conn.frames.push(message);
      if (message.type !== 'auth' || state.ws === 'silent') return;
      if (state.ws === 'close1008' || !validAccess.has(message.token)) {
        socket.close(1008, 'Unauthorized');
        return;
      }
      // 快照之前先来几帧别的，确认探针不会把任意一帧当成就绪。
      socket.send(JSON.stringify({ type: 'presence.update', data: {} }));
      socket.send('not json');
      socket.send(JSON.stringify({ type: 'badge.snapshot', data: { unread: 0 } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const count = (path) => requests.filter((r) => r.path === path).length;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    requests,
    connections,
    issued,
    issue,
    count,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 裸 TCP 服务，用来模拟升级卡住或被拒——ws 的 WebSocketServer 总会把升级做完。 */
async function startRawServer(onSocket) {
  const sockets = [];
  const server = createNetServer((socket) => {
    socket.on('error', () => {});
    sockets.push({ socket, closed: new Promise((resolve) => socket.on('close', resolve)) });
    onSocket(socket);
    socket.resume(); // 不读就看不到对端的 FIN，'close' 永远不来
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}/realtime`,
    sockets,
    async close() {
      for (const { socket } of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function setup(t, { env = {}, now, realtimeUrl } = {}) {
  const backend = await startBackend();
  const stateDir = await mkdtemp(join(tmpdir(), 'synthetic-probe-'));
  const stateFile = join(stateDir, 'session.json');
  const logs = [];
  const config = loadConfig({
    PROBE_BASE_URL: `${backend.url}/`,
    PROBE_ALLOW_INSECURE: '1',
    PROBE_IDENTIFIER: IDENTIFIER,
    PROBE_PASSWORD: PASSWORD,
    PROBE_DEVICE_ID: DEVICE_ID,
    PROBE_TIMEOUT_MS: '2000',
    PROBE_STATE_DIR: stateDir,
    ...env,
  });
  assert.deepEqual(config.invalid, []);
  const probe = createProbe(realtimeUrl ? { ...config, realtimeUrl } : config, {
    log: (entry) => logs.push(entry),
    ...(now ? { now } : {}),
  });
  t.after(async () => {
    await backend.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  return {
    backend,
    probe,
    logs,
    stateDir,
    stateFile,
    readState: async () => JSON.parse(await readFile(stateFile, 'utf8')),
    writeState: (value) =>
      writeFile(stateFile, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }),
  };
}

function assertNoSecrets(logs, backend) {
  const text = JSON.stringify(logs);
  for (const secret of [PASSWORD, IDENTIFIER, DEVICE_ID, ...backend.issued.flatMap((p) => [p.accessToken, p.refreshToken])]) {
    assert.ok(!text.includes(secret), 'a log line leaked a secret or identifier');
  }
}

test('first run logs in, persists tokens 0600, reads conversations and reaches badge.snapshot', async (t) => {
  const { backend, probe, logs, stateDir, stateFile, readState } = await setup(t);

  const result = await probe.runOnce();
  assert.equal(result.result, 'success');
  assert.equal(result.auth, 'login');

  const login = backend.requests.find((r) => r.path === LOGIN);
  assert.equal(login.headers['x-device-id'], DEVICE_ID);
  assert.deepEqual(login.body, { identifier: IDENTIFIER, password: PASSWORD });

  const [pair] = backend.issued;
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.deepEqual(await readState(), {
    refreshToken: pair.refreshToken,
    accessToken: pair.accessToken,
    accessExpiresAt: pair.exp * 1000,
  });
  assert.deepEqual(await readdir(stateDir), ['session.json'], 'atomic write left a temp file behind');

  const conversations = backend.requests.find((r) => r.path === CONVERSATIONS);
  assert.equal(conversations.headers.authorization, `Bearer ${pair.accessToken}`);

  assert.equal(backend.connections.length, 1);
  const [conn] = backend.connections;
  assert.equal('origin' in conn.headers, false, 'the realtime handshake must not carry an Origin header');
  assert.deepEqual(conn.frames, [{ type: 'auth', token: pair.accessToken }]);
  assert.equal(await within(conn.closed, 2000, 'socket close'), 1000);

  const metrics = probe.renderMetrics();
  assert.equal(sample(metrics, `${P}success`), 1);
  assert.equal(sample(metrics, `${P}runs_total{result="success"}`), 1);
  assert.equal(sample(metrics, `${P}runs_total{result="failure"}`), 0);
  assert.ok(sample(metrics, `${P}last_run_timestamp_seconds`) > 0);
  for (const step of ['auth', 'api', 'realtime']) {
    assert.ok(sample(metrics, `${P}step_duration_seconds{step="${step}"}`) >= 0, `no duration for ${step}`);
  }
  assert.ok(!metrics.includes(`${P}failures_total{`));

  const runs = logs.filter((l) => l.event === 'synthetic_probe_run');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].result, 'success');
  assert.equal(typeof runs[0].durationMs, 'number');
  assertNoSecrets(logs, backend);
});

test('a second run reuses the stored access token without login or refresh', async (t) => {
  const { backend, probe } = await setup(t);
  await probe.runOnce();
  const second = await probe.runOnce();
  assert.equal(second.result, 'success');
  assert.equal(second.auth, 'reused');
  assert.equal(backend.count(LOGIN), 1);
  assert.equal(backend.count(REFRESH), 0);
  assert.equal(backend.count(CONVERSATIONS), 2);
  assert.equal(backend.connections.length, 2);
});

test('overlapping runOnce calls share one run', async (t) => {
  const { backend, probe } = await setup(t);
  const [a, b] = await Promise.all([probe.runOnce(), probe.runOnce()]);
  assert.equal(a, b);
  assert.equal(backend.count(LOGIN), 1);
  assert.equal(sample(probe.renderMetrics(), `${P}runs_total{result="success"}`), 1);
});

test('idle() resolves only after the in-flight run has finished (shutdown waits on it)', async (t) => {
  const { probe } = await setup(t);
  assert.equal(await probe.idle(), undefined);
  let finished = false;
  const run = probe.runOnce().then(() => (finished = true));
  await probe.idle();
  assert.equal(finished, true);
  await run;
});

test('a near-expiry access token triggers exactly one refresh, persisted before the API call', async (t) => {
  const { backend, probe, logs, writeState, stateFile } = await setup(t);
  const old = backend.issue(Math.floor(Date.now() / 1000) + 60);
  await writeState({ refreshToken: old.refreshToken, accessToken: old.accessToken, accessExpiresAt: old.exp * 1000 });
  let onDiskAtApiCall = null;
  backend.state.onConversations = () => {
    onDiskAtApiCall = JSON.parse(readFileSync(stateFile, 'utf8'));
  };

  const result = await probe.runOnce();
  assert.equal(result.result, 'success');
  assert.equal(result.auth, 'refreshed');
  assert.equal(backend.count(REFRESH), 1);
  assert.equal(backend.count(LOGIN), 0);
  const refresh = backend.requests.find((r) => r.path === REFRESH);
  assert.deepEqual(refresh.body, { refreshToken: old.refreshToken });

  const fresh = backend.issued.at(-1);
  assert.notEqual(fresh.refreshToken, old.refreshToken);
  assert.equal(onDiskAtApiCall.refreshToken, fresh.refreshToken);
  assert.equal(onDiskAtApiCall.accessToken, fresh.accessToken);
  assert.equal(backend.requests.find((r) => r.path === CONVERSATIONS).headers.authorization, `Bearer ${fresh.accessToken}`);
  assertNoSecrets(logs, backend);
});

test('a rejected refresh token falls through to password login in the same run', async (t) => {
  const { backend, probe, writeState, readState } = await setup(t);
  await writeState({ refreshToken: 'refresh-already-rotated', accessToken: null, accessExpiresAt: 0 });

  const result = await probe.runOnce();
  assert.equal(result.result, 'success');
  assert.equal(result.auth, 'login');
  assert.deepEqual(backend.requests.map((r) => r.path), [REFRESH, LOGIN, CONVERSATIONS]);
  assert.equal((await readState()).refreshToken, backend.issued.at(-1).refreshToken);
});

test('a refresh network failure fails auth/network, keeps the refresh token and does not log in', async (t) => {
  const { backend, probe, writeState, readState } = await setup(t);
  const stored = backend.issue(Math.floor(Date.now() / 1000) + 30);
  await writeState({ refreshToken: stored.refreshToken, accessToken: stored.accessToken, accessExpiresAt: stored.exp * 1000 });
  backend.state.refresh = 'destroy';

  const result = await probe.runOnce();
  assert.equal(result.result, 'failure');
  assert.equal(result.step, 'auth');
  assert.equal(result.reason, 'network');
  assert.equal(backend.count(REFRESH), 1);
  assert.equal(backend.count(LOGIN), 0);
  assert.equal(backend.count(CONVERSATIONS), 0);
  assert.equal(backend.connections.length, 0);
  assert.equal((await readState()).refreshToken, stored.refreshToken);
  const metrics = probe.renderMetrics();
  assert.equal(sample(metrics, `${P}failures_total{step="auth",reason="network"}`), 1);
  assert.equal(sample(metrics, `${P}success`), 0);
  assert.equal(sample(metrics, `${P}step_duration_seconds{step="api"}`), undefined);
});

test('a hanging API call fails api/timeout', async (t) => {
  const { backend, probe } = await setup(t, { env: { PROBE_TIMEOUT_MS: '200' } });
  backend.state.api = 'hang';
  const result = await probe.runOnce();
  assert.deepEqual([result.result, result.step, result.reason], ['failure', 'api', 'timeout']);
  assert.equal(backend.connections.length, 0);
});

test('deviceVerificationRequired fails auth and suppresses login for 15 minutes', async (t) => {
  let clock = Date.now();
  const { backend, probe, logs, stateDir } = await setup(t, { now: () => clock });
  backend.state.login = 'device';

  const first = await probe.runOnce();
  assert.deepEqual([first.result, first.step, first.reason], ['failure', 'auth', 'device_verification_required']);
  assert.equal(backend.count(LOGIN), 1);
  assert.deepEqual(await readdir(stateDir), [], 'no tokens were issued, nothing should be written');

  clock += 14 * 60_000;
  const second = await probe.runOnce();
  assert.deepEqual([second.result, second.step, second.reason], ['failure', 'auth', 'device_verification_required']);
  assert.equal(second.loginSuppressed, true);
  assert.equal(backend.count(LOGIN), 1, 'login was retried inside the 15 minute window');

  clock += 2 * 60_000;
  backend.state.login = 'ok';
  const third = await probe.runOnce();
  assert.equal(third.result, 'success');
  assert.equal(backend.count(LOGIN), 2);

  const metrics = probe.renderMetrics();
  assert.equal(sample(metrics, `${P}failures_total{step="auth",reason="device_verification_required"}`), 2);
  assert.equal(sample(metrics, `${P}runs_total{result="failure"}`), 2);
  assert.equal(sample(metrics, `${P}last_success_timestamp_seconds`), clock / 1000);
  assertNoSecrets(logs, backend);
});

test('a wrong password maps to auth/login_rejected', async (t) => {
  const { backend, probe } = await setup(t);
  backend.state.login = 'reject';
  const result = await probe.runOnce();
  assert.deepEqual([result.result, result.step, result.reason], ['failure', 'auth', 'login_rejected']);
});

test('API 401 fails api/http_401 and clears the access token so the next run refreshes', async (t) => {
  const { backend, probe, readState } = await setup(t);
  backend.state.api = '401';
  const result = await probe.runOnce();
  assert.deepEqual([result.result, result.step, result.reason], ['failure', 'api', 'http_401']);
  const saved = await readState();
  assert.equal(saved.accessToken, null);
  assert.equal(saved.accessExpiresAt, 0);
  assert.equal(saved.refreshToken, backend.issued[0].refreshToken);

  backend.state.api = 'ok';
  const next = await probe.runOnce();
  assert.equal(next.result, 'success');
  assert.equal(next.auth, 'refreshed');
  assert.equal(backend.count(LOGIN), 1);
});

test('a server close with 1008 fails realtime/ws_closed_1008', async (t) => {
  const { backend, probe } = await setup(t);
  backend.state.ws = 'close1008';
  const result = await probe.runOnce();
  assert.deepEqual([result.result, result.step, result.reason], ['failure', 'realtime', 'ws_closed_1008']);
  assert.equal(backend.connections.length, 1);
  assert.equal(await within(backend.connections[0].closed, 2000, 'socket close'), 1008);
});

test('no badge.snapshot within the timeout fails realtime/no_snapshot and closes the socket', async (t) => {
  const { backend, probe } = await setup(t, { env: { PROBE_TIMEOUT_MS: '300' } });
  backend.state.ws = 'silent';
  const result = await probe.runOnce();
  assert.deepEqual([result.result, result.step, result.reason], ['failure', 'realtime', 'no_snapshot']);
  assert.equal(backend.connections[0].frames.length, 1, 'the auth frame was sent');
  assert.equal(await within(backend.connections[0].closed, 2000, 'socket close'), 1000);
  assert.ok(sample(probe.renderMetrics(), `${P}step_duration_seconds{step="realtime"}`) >= 0.25);
});

test('a WebSocket handshake that never completes fails realtime/timeout and is aborted', async (t) => {
  const raw = await startRawServer(() => {});
  t.after(() => raw.close());
  const { probe } = await setup(t, { env: { PROBE_TIMEOUT_MS: '300' }, realtimeUrl: raw.url });
  const result = await probe.runOnce();
  assert.deepEqual([result.result, result.step, result.reason], ['failure', 'realtime', 'timeout']);
  assert.equal(raw.sockets.length, 1);
  await within(raw.sockets[0].closed, 2000, 'the stalled handshake to be aborted');
});

test('an upgrade rejected with HTTP 503 fails realtime/network', async (t) => {
  const raw = await startRawServer((socket) =>
    socket.once('data', () =>
      socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'),
    ),
  );
  t.after(() => raw.close());
  const { probe } = await setup(t, { realtimeUrl: raw.url });
  const result = await probe.runOnce();
  assert.deepEqual([result.result, result.step, result.reason], ['failure', 'realtime', 'network']);
});

test('a corrupt state file is ignored and replaced', async (t) => {
  const { backend, probe, logs, writeState, readState } = await setup(t);
  await writeState('{not json');
  const result = await probe.runOnce();
  assert.equal(result.result, 'success');
  assert.equal(result.auth, 'login');
  assert.ok(logs.some((l) => l.event === 'synthetic_probe_state_ignored'));
  assert.equal((await readState()).refreshToken, backend.issued[0].refreshToken);
});

test('missing config serves configured 0, names the variables and makes no network calls', async () => {
  const logs = [];
  let calls = 0;
  const config = loadConfig({ PROBE_BASE_URL: 'http://plain.example.test', PROBE_PASSWORD: 'hunter2-value' });
  assert.equal(config.configured, false);
  assert.deepEqual([...config.invalid].sort(), ['PROBE_BASE_URL', 'PROBE_DEVICE_ID', 'PROBE_IDENTIFIER']);

  const probe = createProbe(config, {
    log: (entry) => logs.push(entry),
    now: () => 1_750_000_000_000,
    fetchImpl: async () => {
      calls += 1;
      throw new Error('unexpected fetch');
    },
    WebSocketImpl: class {
      constructor() {
        calls += 1;
      }
    },
  });
  assert.deepEqual(await probe.runOnce(), { result: 'skipped' });
  assert.equal(calls, 0);

  const metrics = probe.renderMetrics();
  assert.equal(sample(metrics, `${P}configured`), 0);
  assert.equal(sample(metrics, `${P}last_success_timestamp_seconds`), 1_750_000_000);
  assert.deepEqual(logs, [
    { event: 'synthetic_probe_config_invalid', invalid: ['PROBE_BASE_URL', 'PROBE_IDENTIFIER', 'PROBE_DEVICE_ID'] },
  ]);
  assert.ok(!JSON.stringify(logs).includes('hunter2-value'));
});

test('loadConfig validates and normalises its inputs', () => {
  const base = {
    PROBE_BASE_URL: 'https://api.example.test/',
    PROBE_IDENTIFIER: 'probe',
    PROBE_PASSWORD: 'secret',
    PROBE_DEVICE_ID: DEVICE_ID,
  };
  const ok = loadConfig(base);
  assert.equal(ok.configured, true);
  assert.equal(ok.baseUrl, 'https://api.example.test');
  assert.equal(ok.realtimeUrl, 'wss://api.example.test/realtime');
  assert.deepEqual([ok.intervalSeconds, ok.timeoutMs, ok.metricsPort, ok.stateDir], [300, 10000, 9464, '/var/lib/synthetic-probe']);

  assert.equal(loadConfig({ ...base, PROBE_BASE_URL: 'https://api.example.test/edge//' }).realtimeUrl, 'wss://api.example.test/edge/realtime');
  assert.deepEqual(loadConfig({ ...base, PROBE_BASE_URL: 'http://127.0.0.1:3000' }).invalid, ['PROBE_BASE_URL']);
  const insecure = loadConfig({ ...base, PROBE_BASE_URL: 'http://127.0.0.1:3000', PROBE_ALLOW_INSECURE: '1' });
  assert.equal(insecure.realtimeUrl, 'ws://127.0.0.1:3000/realtime');
  assert.deepEqual(loadConfig({ ...base, PROBE_BASE_URL: 'not a url' }).invalid, ['PROBE_BASE_URL']);
  assert.deepEqual(loadConfig({ ...base, PROBE_BASE_URL: 'https://api.example.test/?x=1' }).invalid, ['PROBE_BASE_URL']);

  assert.deepEqual(loadConfig({ ...base, PROBE_DEVICE_ID: 'too-short' }).invalid, ['PROBE_DEVICE_ID']);
  assert.deepEqual(loadConfig({ ...base, PROBE_DEVICE_ID: 'has spaces in it 0123' }).invalid, ['PROBE_DEVICE_ID']);
  assert.deepEqual(loadConfig({ ...base, PROBE_PASSWORD: '   ' }).invalid, ['PROBE_PASSWORD']);

  assert.equal(loadConfig({ ...base, PROBE_INTERVAL_SECONDS: '30' }).intervalSeconds, 60);
  // 间隔超过 5 分钟，「15 分钟没有一轮走通」的告警会在正常情况下每轮都响。
  assert.equal(loadConfig({ ...base, PROBE_INTERVAL_SECONDS: '600' }).intervalSeconds, 300);
  assert.equal(loadConfig({ ...base, PROBE_TIMEOUT_MS: '600000' }).timeoutMs, 30000);
  assert.deepEqual(loadConfig({ ...base, PROBE_INTERVAL_SECONDS: '5m' }).invalid, ['PROBE_INTERVAL_SECONDS']);
  assert.deepEqual(loadConfig({ ...base, PROBE_TIMEOUT_MS: '0' }).invalid, ['PROBE_TIMEOUT_MS']);
  assert.deepEqual(loadConfig({ ...base, PROBE_METRICS_PORT: '70000' }).invalid, ['PROBE_METRICS_PORT']);
});

test('metrics text before the first run: seeded last_success, zeroed run counters, escaped labels', () => {
  const config = loadConfig({
    PROBE_BASE_URL: 'https://api.example.test',
    PROBE_IDENTIFIER: 'probe',
    PROBE_PASSWORD: 'secret',
    PROBE_DEVICE_ID: DEVICE_ID,
  });
  const probe = createProbe(config, { now: () => 1_750_000_000_123, log: () => {} });
  const metrics = probe.renderMetrics();

  assert.ok(metrics.endsWith('\n'));
  assert.equal(sample(metrics, `${P}configured`), 1);
  assert.match(metrics, new RegExp(`\\n${P}last_success_timestamp_seconds 1750000000\\.123\\n`));
  assert.equal(sample(metrics, `${P}runs_total{result="success"}`), 0);
  assert.equal(sample(metrics, `${P}runs_total{result="failure"}`), 0);
  assert.equal(sample(metrics, `${P}success`), undefined, 'success must be absent before the first run');
  assert.equal(sample(metrics, `${P}last_run_timestamp_seconds`), undefined);
  assert.ok(!metrics.includes(`${P}failures_total`));
  for (const [name, type] of [
    ['configured', 'gauge'],
    ['last_success_timestamp_seconds', 'gauge'],
    ['runs_total', 'counter'],
  ]) {
    assert.ok(metrics.includes(`# TYPE ${P}${name} ${type}\n`), `missing TYPE for ${name}`);
    assert.ok(metrics.includes(`# HELP ${P}${name} `), `missing HELP for ${name}`);
  }

  assert.equal(escapeLabelValue('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  assert.equal(escapeLabelValue('plain'), 'plain');
});

test('the metrics server serves /metrics only', async (t) => {
  const server = createMetricsServer(() => `${P}configured 1\n`);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const get = (path, method = 'GET') =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, agent: false }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
      });
      req.on('error', reject);
      req.end();
    });

  const ok = await get('/metrics');
  assert.equal(ok.status, 200);
  assert.equal(ok.type, 'text/plain; version=0.0.4; charset=utf-8');
  assert.equal(ok.body, `${P}configured 1\n`);
  assert.equal((await get('/metrics?debug=1')).status, 200);
  assert.equal((await get('/')).status, 404);
  assert.equal((await get('/metrics/extra')).status, 404);
  assert.equal((await get('/metrics', 'POST')).status, 404);
});
