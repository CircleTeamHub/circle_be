import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const CADDYFILE = read('deploy/Caddyfile.admin');
const CADDY_DOCKERFILE = read('Dockerfile.caddy');
const PROD = read('docker-compose.prod.yml');
const LOGS_COMPOSE = read('monitoring/docker-compose.logs.yml');
const ALLOY = read('monitoring/alloy/config.alloy');
const LOKI = read('monitoring/loki/config.yml');
const RULES_PATH = 'monitoring/loki/rules/fake/circle.yml';

function globalBlock() {
  return CADDYFILE.match(/^\{\n([\s\S]*?)\n\}/)[1];
}

/**
 * Caddy 的日志此前只在 `docker compose logs` 里：TLS 续期失败、反代连不上上游、
 * /chat-ws 握手的代理视角都进不了 Loki。采集器刻意不碰 Docker socket 和主机
 * 日志目录（monitoring/logs.md），所以 Caddy 自己再写一份到专用卷里。
 */
test('Caddy writes a sanitized, collectable copy of only the safe log streams', () => {
  const block = globalBlock();
  const logger = block.match(/\tlog collected \{\n([\s\S]*?)\n\t\}/);
  assert.ok(logger, 'no collected logger in the Caddy global options');
  const body = logger[1];
  assert.match(body, /output file \/var\/log\/caddy\/collected\.log \{/);
  // 采集器以非 root 运行，读不了 Caddy 默认的 0600。
  assert.match(body, /mode 0644/);
  assert.match(body, /roll_size \d+MiB/);
  assert.match(body, /roll_keep \d+/);
  // 只收这几类；不能收站点 access log（那会把每个 API 请求都落盘）。
  const include = body.match(/include (.+)/)[1].split(/\s+/);
  assert.deepEqual(include.sort(), [
    'http.handlers.reverse_proxy',
    'http.log.access.chat_ws',
    'http.log.error',
    'tls',
  ]);
  // 整条 uri 删掉，而不只是 query：分享链接、临时聊天、二维码的 token 就在路径里
  // （后端自己的日志只记路由模板，见 src/logging/log-sanitizer.ts 的 safeLogPath）。
  // 全部请求头、IP、端口同样在编码前删除。
  assert.doesNotMatch(body, /request>uri regexp/);
  for (const field of [
    /request>uri delete/,
    /request>headers delete/,
    /request>remote_ip delete/,
    /request>client_ip delete/,
    /request>remote_port delete/,
  ]) {
    assert.match(body, field);
  }
  // 站点级 access log 依旧只给 /chat-ws。
  assert.doesNotMatch(CADDYFILE, /\n\tlog \{/);
});

const SANITIZING_FIELDS = [
  /request>uri delete/,
  /request>headers delete/,
  /request>remote_ip delete/,
  /request>client_ip delete/,
  /request>remote_port delete/,
  /error regexp "->\\\[\?\[0-9a-fA-F\.:\]\+\\\]\?:\[0-9\]\+" "->REDACTED"/,
];

function namedLogger(name) {
  const logger = globalBlock().match(new RegExp(`\\tlog ${name} \\{\\n([\\s\\S]*?)\\n\\t\\}`));
  assert.ok(logger, `no ${name} logger in the Caddy global options`);
  return logger[1];
}

test('the same streams still reach stdout, sanitized the same way', () => {
  // Caddyfile 会把具名 logger include 的命名空间从默认 logger 里 exclude 掉：只写
  // 文件的话，`docker compose logs caddy` 就再也看不到证书续期失败和 502 的原因。
  const body = namedLogger('collected_stdout');
  assert.match(body, /^\t\toutput stdout\n/);
  const include = body.match(/include (.+)/)[1].split(/\s+/).sort();
  // /chat-ws 握手有自己的 stdout logger，不重复收。
  assert.deepEqual(include, ['http.handlers.reverse_proxy', 'http.log.error', 'tls']);
  for (const name of ['collected', 'collected_stdout']) {
    for (const field of SANITIZING_FIELDS) {
      assert.match(namedLogger(name), field, `${name} lacks ${field}`);
    }
  }
});

test("the peer-address filter removes the client's IP and port from socket errors", () => {
  // 客户端中途断开时，反代把 `write tcp 本端->客户端IP:端口: broken pipe` 写进 error。
  // Caddyfile 的引号不反转义反斜杠，所以这里拿到的就是 Caddy（RE2）看到的正则。
  const pattern = namedLogger('collected').match(/error regexp "([^"]+)" "([^"]+)"/);
  assert.ok(pattern, 'no error filter');
  const redact = (text) => text.replace(new RegExp(pattern[1], 'g'), pattern[2]);
  assert.equal(
    redact('writing: write tcp 172.17.0.2:8080->192.168.65.1:53899: write: broken pipe'),
    'writing: write tcp 172.17.0.2:8080->REDACTED: write: broken pipe',
  );
  assert.equal(
    redact('readfrom tcp [fd00::2]:443->[2001:db8::1]:51234: connection reset by peer'),
    'readfrom tcp [fd00::2]:443->REDACTED: connection reset by peer',
  );
  // 上游拨号失败只有本端看到的上游地址，原样保留 —— 那是排障要看的。
  assert.equal(
    redact('dial tcp 172.18.0.5:3000: connect: connection refused'),
    'dial tcp 172.18.0.5:3000: connect: connection refused',
  );
});

test('CI rebuilds the Caddy runtime stage so Alpine fixes are not served from cache', () => {
  // 基础镜像没更新时，带缓存的构建会沿用旧的 apk upgrade 层，已修好的系统包漏洞
  // 照样让 Trivy 的 Caddy 扫描红（brotli-libs CVE-2026-111497 就是这样）。
  assert.match(CADDY_DOCKERFILE, /^FROM caddy:2-alpine AS runtime\nRUN apk upgrade --no-cache$/m);
  const build = read('.github/workflows/ci.yml').match(
    /file: Dockerfile\.caddy\n([\s\S]*?)\n\n/,
  );
  assert.ok(build, 'no Caddy image build in ci.yml');
  assert.match(build[1], /\n\s*no-cache-filters: runtime(\n|$)/);
});

test('only /chat-ws handshakes reach an access log on the API site', () => {
  // 站点里写了 `log chat_ws` 就开了整站 access log：没被 log_name 认领的请求落到
  // 默认 logger（stdout、不过滤），完整 URI（分享/临时聊天 token、对象存储签名）、
  // 客户端 IP 和请求头都在里面。实测过：没有 log_skip 时每个请求（含 404）都会写。
  const api = CADDYFILE.slice(CADDYFILE.indexOf('{$API_DOMAIN}'), CADDYFILE.indexOf('{$ADMIN_DOMAIN}'));
  assert.match(api, /\n\tlog chat_ws \{/);
  assert.match(api, /\n\t@not_chat_ws not path \/chat-ws \/chat-ws\/\*\n\tlog_skip @not_chat_ws\n/);
  // 管理域没有 log 指令，它的请求本来就不进 access log。
  const admin = CADDYFILE.slice(CADDYFILE.indexOf('{$ADMIN_DOMAIN}'));
  assert.doesNotMatch(admin, /\n\tlog\b/);
});

test('both websocket gateways get their connection trace ID from Caddy', () => {
  // header_up 无条件写 X-Connection-Trace-Id；变量没设的路径会把它置成空值，网关
  // 只能另起一个 ID，和 Caddy 这侧对不上（/realtime 此前就是这样）。
  assert.match(CADDYFILE, /@chat_ws path \/chat-ws \/chat-ws\/\*\n\tvars @chat_ws connection_trace_id ws-\{http\.request\.uuid\}/);
  assert.match(CADDYFILE, /@realtime_ws path \/realtime\n\tvars @realtime_ws connection_trace_id ws-\{http\.request\.uuid\}/);
  assert.match(CADDYFILE, /header_up X-Connection-Trace-Id \{http\.vars\.connection_trace_id\}/);
  // access log 的范围不随之扩大。
  assert.doesNotMatch(CADDYFILE, /log_name @realtime_ws/);
  // 后端两个网关读的是同一个头、同一套校验。
  for (const file of ['src/chat/chat.gateway.ts', 'src/realtime/realtime.gateway.ts']) {
    assert.match(read(file), /from 'src\/logging\/connection-trace-id'/, `${file} has its own trace-ID parsing`);
  }
});

test('the Caddy log directory is readable by the collector and lives in its own volume', () => {
  assert.match(CADDY_DOCKERFILE, /mkdir -p \/var\/log\/caddy/);
  assert.match(CADDY_DOCKERFILE, /chmod 0755 \/var\/log\/caddy/);
  assert.match(PROD, /- caddy_logs:\/var\/log\/caddy\n/);
  assert.match(PROD, /\n {2}caddy_logs:\n/);
});

test('Alloy collects the Caddy copy with the same bounded labels as app logs', () => {
  assert.match(LOGS_COMPOSE, /- caddy_logs:\/var\/log\/caddy:ro/);
  assert.match(
    LOGS_COMPOSE,
    /caddy_logs:\n\s*external: true\n\s*name: \$\{CIRCLE_BE_PROJECT_NAME:-circle-be\}_caddy_logs/,
  );
  const source = ALLOY.match(/loki\.source\.file "caddy" \{([\s\S]*?)\n\}/);
  assert.ok(source, 'no Caddy file source in Alloy');
  // 只跟活动文件：滚动出去的旧文件换了名字，再匹配一次就会整份重读、重复入库。
  assert.match(source[1], /__path__\s*=\s*"\/var\/log\/caddy\/collected\.log"/);
  assert.match(source[1], /service\s*=\s*"caddy"/);
  const processBlock = ALLOY.match(/loki\.process "caddy" \{([\s\S]*?)\n\}/);
  assert.ok(processBlock, 'no Caddy process stage');
  assert.match(processBlock[1], /stage\.label_keep \{\s*values = \["service", "environment", "level"\]/);
});

test('Loki evaluates log alert rules and sends them to Alertmanager', () => {
  assert.match(LOKI, /\nruler:\n/);
  assert.match(LOKI, /alertmanager_url: http:\/\/alertmanager:9093/);
  assert.match(LOKI, /directory: \/etc\/loki\/rules/);
  assert.match(LOGS_COMPOSE, /- \.\/loki\/rules:\/etc\/loki\/rules:ro/);
  // Loki 待在内部的 logs 网络里；让 Alertmanager 也加入，而不是把 Loki 放出去。
  assert.match(LOGS_COMPOSE, /\n {2}alertmanager:\n\s*networks: \[default, logs\]/);
  assert.ok(existsSync(join(ROOT, RULES_PATH)), `${RULES_PATH} missing`);
  const rules = read(RULES_PATH);
  for (const name of [
    'BackendFatalExit',
    'BackendErrorLogSpike',
    'CaddyProxyErrors',
    'CaddyCertificateErrors',
    'SecurityCodeGuessing',
    'SecurityCodeLockouts',
    'RevokedSessionTokenReplay',
    'InvalidTokenSpike',
  ]) {
    assert.match(rules, new RegExp(`- alert: ${name}\\n`), `${name} missing`);
  }
  for (const severity of rules.matchAll(/severity: (\w+)/g)) {
    assert.ok(['warning', 'critical'].includes(severity[1]));
  }
});

function lokiRule(rules, name) {
  const block = rules.match(new RegExp(`- alert: ${name}\\n([\\s\\S]*?)(?=\\n\\s*- alert: |$)`));
  assert.ok(block, `${name} missing`);
  const window = block[1].match(/\[(\d+)m\]\)\) >/);
  const forClause = block[1].match(/\n\s*for: (\d+)m/);
  return { body: block[1], window: window && Number(window[1]), for: forClause && Number(forClause[1]) };
}

test('log spike alerts need sustained errors, not one burst', () => {
  // 窗口比 for 长时，一阵突发会在窗口里待满 for，于是一次蓝绿切换就能响。
  const rules = read(RULES_PATH);
  for (const name of ['BackendErrorLogSpike', 'CaddyProxyErrors', 'SecurityCodeGuessing', 'InvalidTokenSpike']) {
    const rule = lokiRule(rules, name);
    assert.ok(rule.window && rule.for, `${name} needs a range window and a for`);
    assert.ok(rule.for > rule.window, `${name}: for (${rule.for}m) must exceed its window (${rule.window}m)`);
  }
  // 客户端断开之类是 warn/debug，与上游无关。
  assert.match(lokiRule(rules, 'CaddyProxyErrors').body, /\{service="caddy", level="error"\}/);
});

test('backend and database outages inhibit the log spike alerts they cause', () => {
  const am = read('monitoring/alertmanager/alertmanager.yml');
  const targets = (source) => {
    const match = am.match(
      new RegExp(`alertname = "${source}"\\n\\s*target_matchers:\\n\\s*- alertname =~ "([^"]+)"`),
    );
    assert.ok(match, `no inhibit rule sourced from ${source}`);
    return match[1].split('|');
  };
  assert.ok(targets('CircleBeNoTarget').includes('BackendErrorLogSpike'));
  assert.ok(targets('PostgresDown').includes('BackendErrorLogSpike'));
  // Caddy 的反代失败也覆盖 MinIO 和 admin_web；后端挂掉时它们的故障别处看不到。
  assert.ok(!targets('CircleBeNoTarget').includes('CaddyProxyErrors'));
});

test('the manual logs-overlay enable command recreates Alertmanager onto the logs network', () => {
  // Loki 只在 logs 网络里；--no-deps 不会顺带重建 Alertmanager，漏掉它日志告警就一条
  // 也发不出去。
  const doc = read('monitoring/logs.md');
  const command = doc.match(/-f monitoring\/docker-compose\.logs\.yml up -d --no-deps ([^\n`]+)/);
  assert.ok(command, 'no enable command in monitoring/logs.md');
  const services = command[1].trim().split(/\s+/);
  for (const service of ['loki', 'alloy', 'grafana', 'prometheus', 'alertmanager']) {
    assert.ok(services.includes(service), `enable command misses ${service}`);
  }
});

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) files.push(path);
  }
  return files;
}

test('the security log rules match event names the backend actually emits', () => {
  // 规则按字符串匹配事件名：代码里改个名字，告警就悄悄失效，什么都不会报错。
  const rules = read(RULES_PATH);
  const source = sourceFiles('src').map(read).join('\n');
  const names = new Set();
  for (const m of rules.matchAll(/securityEvent=~?"([^"]+)"/g)) {
    for (const name of m[1].split('|')) names.add(name);
  }
  assert.ok(names.size >= 5, `expected the security rules, found ${[...names]}`);
  for (const name of names) {
    assert.ok(source.includes(`'${name}'`), `no backend code emits securityEvent ${name}`);
  }
  // 吊销令牌重放按会话、按用户去重：一次「登出所有设备」本身就有十几条原始事件。
  const replay = lokiRule(rules, 'RevokedSessionTokenReplay').body;
  assert.match(replay, /sum by \(metadata_sessionId\)/);
  assert.match(replay, /count\(sum by \(userId\)/);
  assert.ok(read('src/auth/auth.strategy.ts').includes('metadata: { sessionId: payload.sid'), 'session_revoked_token_used no longer carries metadata.sessionId');
  // InvalidTokenSpike 读 metadata.authFailureReason（json 解析器展开成
  // metadata_authFailureReason）。
  assert.match(rules, /metadata_authFailureReason="token_invalid"/);
  const filter = read('src/filters/all-exception.filter.ts');
  assert.match(filter, /metadata: authFailureReason \? \{ authFailureReason \} : undefined/);
  assert.ok(source.includes("'token_invalid'"), 'token_invalid is no longer an auth failure reason');
});
