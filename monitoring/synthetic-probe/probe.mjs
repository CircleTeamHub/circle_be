// 合成探针：每隔几分钟，用一个专用测试账号把真实用户最短的那条路走一遍——
//   1. 拿到有效的 access token（能复用就复用 → 否则 refresh 轮换 → 再不行才密码登录）；
//   2. 调一次最便宜的鉴权读接口 GET /api/v1/chat/conversations；
//   3. 经公网地址连 /realtime，发 auth 帧，等到 badge.snapshot 即算就绪，随即断开。
// 结果暴露在 :9464/metrics，每次运行再往 stdout 打一行 JSON。
//
// 为什么要有它：blackbox_exporter 只能证明「端口开着、/health 回 200」。JWT 密钥配错、refresh
// 轮换坏掉、数据库读路径卡死、实时网关握手后不再推快照，全是静默故障——/health 照样是绿的，
// 用户却登不上、收不到消息，直到有人来投诉。
//
// 证明的：公网入口（DNS/TLS/Caddy）→ 鉴权与会话轮换 → 一条走数据库的读路径 → 实时网关鉴权与首帧
// 推送，对这个账号此刻是通的。不证明的：发消息/投递/推送/上传（从不写业务数据，唯一的写入是登录和
// refresh 本身产生的会话记录）；别的用户、别的网络能否连上（与后端同机部署时绕不开本机网络，
// 安全组挡住外网它也看不出）；长连接能否保持。
//
// 运维须知：陌生设备登录要受信任设备批准——首次报 device_verification_required 时，先用该账号已受
// 信任的设备批准这个 PROBE_DEVICE_ID；登录失败（任何原因）后 15 分钟内不再试，免得撞上登录限流。
// refresh token 严格单次使用，重放已轮换的旧 token 会吊销整个会话族：所以新 token 先落盘再用，且同一个
// PROBE_STATE_DIR 只能有一个探针进程（session.json 的 accessExpiresAt 是毫秒时间戳）。
// 零依赖，node:22 镜像只读挂载本文件即可运行。日志不含 token、密码、账号、设备 ID 和响应体。
import { createServer } from 'node:http';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const REUSE_MARGIN_MS = 120_000;
const LOGIN_BACKOFF_MS = 15 * 60_000;
const FIRST_RUN_DELAY_MS = 5_000;
const PREFIX = 'circle_synthetic_probe_';
const EMPTY_SESSION = Object.freeze({ refreshToken: null, accessToken: null, accessExpiresAt: 0 });

const defaultLog = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);
const fail = (reason) => ({ ok: false, reason });
const isToken = (v) => typeof v === 'string' && v.length > 0;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normaliseBaseUrl(raw, allowInsecure) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const schemeOk = url.protocol === 'https:' || (allowInsecure && url.protocol === 'http:');
  if (!schemeOk || url.search || url.hash || url.username || url.password) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function loadConfig(env) {
  const invalid = [];
  const required = (name, isValid = () => true) => {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '' && isValid(value)) return value;
    invalid.push(name);
    return null;
  };
  const integer = (name, fallback, min, max) => {
    const raw = env[name]?.trim() ?? '';
    if (raw === '') return fallback;
    if (/^\d+$/.test(raw) && Number(raw) >= min && Number(raw) <= max) return Number(raw);
    invalid.push(name);
    return fallback;
  };

  const allowInsecure = env.PROBE_ALLOW_INSECURE === '1';
  const rawBase = required('PROBE_BASE_URL', (v) => normaliseBaseUrl(v, allowInsecure) !== null);
  const baseUrl = rawBase === null ? null : normaliseBaseUrl(rawBase, allowInsecure);
  const config = {
    baseUrl,
    realtimeUrl: baseUrl === null ? null : `${baseUrl.replace(/^http/, 'ws')}/realtime`,
    identifier: required('PROBE_IDENTIFIER'),
    password: required('PROBE_PASSWORD'),
    deviceId: required('PROBE_DEVICE_ID', (v) => DEVICE_ID_RE.test(v)),
    // 上限跟着告警走：SyntheticProbeFailing 按「15 分钟没有一轮走通」判，间隔超过 5 分钟
    // 就凑不够 3 轮，正常也会每轮报一次；三步各自的超时加起来也得远小于一个间隔。
    intervalSeconds: Math.min(300, Math.max(60, integer('PROBE_INTERVAL_SECONDS', 300, 0, 86_400))),
    timeoutMs: Math.min(30_000, integer('PROBE_TIMEOUT_MS', 10_000, 1, 600_000)),
    metricsPort: integer('PROBE_METRICS_PORT', 9464, 1, 65_535),
    stateDir: env.PROBE_STATE_DIR?.trim() || '/var/lib/synthetic-probe',
  };
  return { configured: invalid.length === 0, invalid, ...config };
}

export function escapeLabelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function httpReason(status) {
  if (status === 401 || status === 403 || status === 429) return `http_${status}`;
  if (status >= 400 && status < 500) return 'http_4xx';
  return status >= 500 ? 'http_5xx' : 'bad_response';
}

const errorReason = (err) => (err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network');
const closeReason = (code) => ([1008, 1011, 1013].includes(code) ? `ws_closed_${code}` : 'ws_closed_other');

function jwtExpiryMs(token) {
  const payload = parseJson(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  return Number.isFinite(payload?.exp) ? payload.exp * 1000 : 0;
}

function tokenPair(data) {
  if (!data || !isToken(data.accessToken) || !isToken(data.refreshToken)) return null;
  return { accessToken: data.accessToken, refreshToken: data.refreshToken };
}

export function createProbe(config, deps = {}) {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const WebSocketImpl = deps.WebSocketImpl ?? globalThis.WebSocket;
  const log = deps.log ?? defaultLog;
  const stateFile = join(config.stateDir, 'session.json');

  let session = EMPTY_SESSION;
  let sessionLoaded = false;
  let writeSeq = 0;
  let loginBlockedUntil = 0;
  let lastLoginReason = null;
  let inflight = null;
  // lastSuccessAt 以进程启动时间起算：重启后一直不成功，`time() - last_success` 照样会越过告警阈值。
  let metrics = { lastRunAt: null, lastSuccess: null, lastSuccessAt: now(), runs: { success: 0, failure: 0 },
    failures: new Map(), durations: new Map() };

  if (!config.configured) log({ event: 'synthetic_probe_config_invalid', invalid: config.invalid });

  async function loadSession() {
    sessionLoaded = true;
    const text = await readFile(stateFile, 'utf8').catch((err) => {
      if (err?.code !== 'ENOENT') log({ event: 'synthetic_probe_state_unreadable', error: err?.code ?? 'unknown' });
      return null;
    });
    const raw = text === null ? null : parseJson(text);
    if (!raw || typeof raw !== 'object') {
      if (text !== null) log({ event: 'synthetic_probe_state_ignored', error: 'corrupt' });
      return;
    }
    session = {
      refreshToken: isToken(raw.refreshToken) ? raw.refreshToken : null,
      accessToken: isToken(raw.accessToken) ? raw.accessToken : null,
      accessExpiresAt: Number.isFinite(raw.accessExpiresAt) ? raw.accessExpiresAt : 0,
    };
  }

  // 同目录 0600 临时文件 + rename：磁盘上要么旧要么新；断电留下半截就当损坏忽略、重新登录，不会重放旧 token。
  // 写盘失败只记日志、继续用内存里的 token：最坏是重启后旧 refresh token 被拒，退回登录。
  async function saveSession(next) {
    session = next;
    const tmp = join(config.stateDir, `.session.json.${process.pid}.${++writeSeq}.tmp`);
    try {
      await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(tmp, stateFile);
    } catch (err) {
      log({ event: 'synthetic_probe_state_write_failed', error: err?.code ?? 'unknown' });
      await unlink(tmp).catch(() => {});
    }
  }

  const adopt = (pair) => saveSession({ ...pair, accessExpiresAt: jwtExpiryMs(pair.accessToken) });

  async function request(method, path, { body, token } = {}) {
    const headers = { accept: 'application/json', 'x-device-id': config.deviceId };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    // redirect: 'manual'——3xx 记 bad_response，绝不带着 Authorization 跟到别处去。
    const init = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(config.timeoutMs) };
    try {
      const res = await fetchImpl(`${config.baseUrl}${path}`, body === undefined ? init : { ...init, body: JSON.stringify(body) });
      return { status: res.status, ok: res.ok, json: parseJson(await res.text()) };
    } catch (err) {
      return { error: errorReason(err) };
    }
  }

  async function refresh() {
    const r = await request('POST', '/api/v1/auth/refresh', { body: { refreshToken: session.refreshToken } });
    if (r.error) return fail(r.error);
    if (r.status === 401 || r.status === 403) {
      await saveSession(EMPTY_SESSION);
      return { ok: false, rejected: true };
    }
    if (!r.ok) return fail(httpReason(r.status));
    const result = await takeTokens(r);
    // 2xx 却拿不到新 token：旧 token 多半已被轮换掉，再拿它 refresh 会被当成重放而吊销整个会话族。
    if (!result.ok) await saveSession({ ...session, refreshToken: null });
    return result;
  }

  async function attemptLogin() {
    const body = { identifier: config.identifier, password: config.password };
    const r = await request('POST', '/api/v1/auth/login', { body });
    if (r.error) return fail(r.error);
    // 密码不对时后端回的是 403（InvalidCredentials），管理员账号走这条路也是 403。
    if (r.status === 401 || r.status === 403) return fail('login_rejected');
    if (!r.ok) return fail(httpReason(r.status));
    if (r.json?.code === 0 && r.json.data?.deviceVerificationRequired === true) {
      return fail('device_verification_required');
    }
    return takeTokens(r);
  }

  async function takeTokens(r) {
    const pair = r.json?.code === 0 ? tokenPair(r.json.data) : null;
    if (pair) await adopt(pair);
    return pair ? { ok: true } : fail('bad_response');
  }

  async function login() {
    const attemptedAt = now();
    if (attemptedAt < loginBlockedUntil) return { ...fail(lastLoginReason), loginSuppressed: true };
    const result = await attemptLogin();
    loginBlockedUntil = result.ok ? 0 : attemptedAt + LOGIN_BACKOFF_MS;
    lastLoginReason = result.ok ? null : result.reason;
    return result;
  }

  async function authStep() {
    if (session.accessToken && session.accessExpiresAt - now() > REUSE_MARGIN_MS) return { ok: true, via: 'reused' };
    if (session.refreshToken) {
      const r = await refresh();
      if (r.ok) return { ok: true, via: 'refreshed' };
      if (!r.rejected) return r;
    }
    const r = await login();
    return r.ok ? { ok: true, via: 'login' } : r;
  }

  async function apiStep() {
    const r = await request('GET', '/api/v1/chat/conversations', { token: session.accessToken });
    if (r.error) return fail(r.error);
    if (r.status === 401) {
      await saveSession({ ...session, accessToken: null, accessExpiresAt: 0 });
      return fail('http_401');
    }
    if (r.status !== 200) return fail(httpReason(r.status));
    return r.json?.code === 0 && Array.isArray(r.json.data) ? { ok: true } : fail('bad_response');
  }

  // 每条路径（成功、被关、超时）都要关掉 socket：服务端每个用户最多 5 条连接。
  // 不设 Origin（Node 的全局 WebSocket 本来就不发）：缺省 Origin 放行，错的在升级时就被拒。
  // 升级前失败（DNS/TCP/TLS，或升级被 403/503 拒）时标准 API 拿不到状态码，统一记 network。
  function realtimeStep() {
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocketImpl(config.realtimeUrl);
      } catch {
        resolve(fail('network'));
        return;
      }
      let opened = false;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ws.readyState === 0 || ws.readyState === 1) ws.close(1000);
        resolve(result);
      };
      const timer = setTimeout(() => finish(fail(opened ? 'no_snapshot' : 'timeout')), config.timeoutMs);
      ws.addEventListener('open', () => {
        opened = true;
        ws.send(JSON.stringify({ type: 'auth', token: session.accessToken }));
      });
      ws.addEventListener('message', (event) => {
        const message = typeof event.data === 'string' ? parseJson(event.data) : null;
        if (message?.type === 'badge.snapshot') finish({ ok: true });
      });
      ws.addEventListener('close', (event) => finish(fail(opened ? closeReason(event.code) : 'network')));
      // 升级被拒时 Node 22 只派发 error、不派发 close（readyState 一直停在 CONNECTING），
      // 只等 close 的话要等到超时才失败、还会记成 timeout。打开之后的 error 之后必有 close，交给它。
      ws.addEventListener('error', () => {
        if (!opened) finish(fail('network'));
      });
    });
  }

  const STEPS = { auth: authStep, api: apiStep, realtime: realtimeStep };

  async function doRun() {
    if (!sessionLoaded) await loadSession();
    const runStart = performance.now();
    const durations = new Map();
    let outcome = { ok: true };
    let failedStep = null;
    let via = null;
    for (const [name, step] of Object.entries(STEPS)) {
      const stepStart = performance.now();
      outcome = await step();
      durations.set(name, (performance.now() - stepStart) / 1000);
      via = via ?? outcome.via ?? null;
      if (!outcome.ok) {
        failedStep = name;
        break;
      }
    }

    const ok = failedStep === null;
    const result = ok ? 'success' : 'failure';
    const at = now();
    const failures = new Map(metrics.failures);
    if (!ok) {
      const key = `${failedStep}\n${outcome.reason}`;
      failures.set(key, { step: failedStep, reason: outcome.reason, count: (failures.get(key)?.count ?? 0) + 1 });
    }
    const runs = { ...metrics.runs, [result]: metrics.runs[result] + 1 };
    const lastSuccessAt = ok ? at : metrics.lastSuccessAt;
    metrics = { lastRunAt: at, lastSuccess: ok, lastSuccessAt, runs, failures, durations };

    const entry = {
      event: 'synthetic_probe_run',
      result,
      ...(ok ? {} : { step: failedStep, reason: outcome.reason }),
      ...(via ? { auth: via } : {}),
      ...(outcome.loginSuppressed ? { loginSuppressed: true } : {}),
      durationMs: Math.round(performance.now() - runStart),
    };
    log(entry);
    return entry;
  }

  function runOnce() {
    if (!config.configured) return Promise.resolve({ result: 'skipped' });
    if (!inflight) inflight = doRun().finally(() => (inflight = null));
    return inflight;
  }

  function renderMetrics() {
    const m = metrics;
    const single = (value, transform = Number) => (value === null ? [] : [[{}, transform(value)]]);
    const toSeconds = (ms) => ms / 1000;
    // [名字, 类型, 说明, 样本 [labels, value][]]；没有样本的指标整族不输出。
    const families = [
      ['configured', 'gauge', 'Config is complete and valid (1) or the probe is idle (0).', single(config.configured)],
      ['success', 'gauge', 'Last completed run passed auth, api and realtime (1) or not (0).', single(m.lastSuccess)],
      ['last_run_timestamp_seconds', 'gauge', 'Unix time the last run completed.', single(m.lastRunAt, toSeconds)],
      ['last_success_timestamp_seconds', 'gauge', 'Unix time of the last success; starts at process start.',
        single(m.lastSuccessAt, toSeconds)],
      ['runs_total', 'counter', 'Completed probe runs by result.',
        [[{ result: 'success' }, m.runs.success], [{ result: 'failure' }, m.runs.failure]]],
      ['failures_total', 'counter', 'Failed runs by failed step and reason.',
        [...m.failures.values()].map((f) => [{ step: f.step, reason: f.reason }, f.count])],
      ['step_duration_seconds', 'gauge', 'Duration of each step attempted in the last run.',
        [...m.durations].map(([step, seconds]) => [{ step }, seconds])],
    ];
    const lines = [];
    for (const [name, type, help, samples] of families) {
      if (samples.length === 0) continue;
      lines.push(`# HELP ${PREFIX}${name} ${help}`, `# TYPE ${PREFIX}${name} ${type}`);
      for (const [labels, value] of samples) {
        const pairs = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
        lines.push(`${PREFIX}${name}${pairs.length ? `{${pairs.join(',')}}` : ''} ${value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  // 关停时用：正在跑的那一轮（没有则立即完成）。
  const idle = () => inflight ?? Promise.resolve();

  return { runOnce, renderMetrics, idle };
}

export function createMetricsServer(renderMetrics) {
  return createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/metrics' || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : renderMetrics());
  });
}

function main() {
  const config = loadConfig(process.env);
  const probe = createProbe(config);
  const server = createMetricsServer(probe.renderMetrics);
  let timer = null;
  let stopping = false;

  const loop = async () => {
    await probe.runOnce().catch((err) => defaultLog({ event: 'synthetic_probe_internal_error', error: err?.name }));
    if (!stopping) timer = setTimeout(loop, config.intervalSeconds * 1000);
  };
  server.on('error', (err) => {
    defaultLog({ event: 'synthetic_probe_metrics_server_error', error: err?.code ?? 'unknown' });
    process.exit(1);
  });
  server.listen(config.metricsPort, () => {
    const { configured, intervalSeconds, metricsPort } = config;
    defaultLog({ event: 'synthetic_probe_started', configured, intervalSeconds, metricsPort });
    if (configured) timer = setTimeout(loop, FIRST_RUN_DELAY_MS);
  });

  // 先等正在跑的那一轮（最多 8 秒，docker stop 默认给 10 秒）：服务端已经轮换了刷新
  // 令牌、新令牌还没写盘时退出，下一轮会拿旧令牌去刷新，触发重用检测吊销整个会话。
  const shutdown = async () => {
    stopping = true;
    clearTimeout(timer);
    await Promise.race([probe.idle().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 8_000).unref())]);
    setTimeout(() => process.exit(0), 2_000).unref();
    server.close(() => process.exit(0)).closeAllConnections();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

function isMainModule() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) main();
