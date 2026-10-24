import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = readFileSync(join(ROOT, 'docker-compose.prod.yml'), 'utf8').replace(/\r\n/g, '\n');
const CADDYFILE = readFileSync(join(ROOT, 'deploy/Caddyfile.admin'), 'utf8');

function service(name) {
  const match = COMPOSE.match(
    new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[a-z][a-z_-]*:\\n|\\nvolumes:)`),
  );
  assert.ok(match, `service ${name} not found`);
  return match[1];
}

/**
 * caddy 和 admin_web 此前没有 healthcheck：进程活着但不再应答时，`docker ps`
 * 照样显示 Up，depends_on 也拿不到「已就绪」。两者的镜像都是 alpine，自带
 * busybox wget，探的都是容器内的本地端口，不经过公网和证书。
 */
test('caddy and admin_web declare a local healthcheck', () => {
  for (const [name, url] of [
    // /config/ 等其余 admin 接口每次请求都记一行 INFO，/metrics 只记 debug。
    ['caddy', 'http://127.0.0.1:2019/metrics'],
    ['admin_web', 'http://127.0.0.1/'],
  ]) {
    const block = service(name);
    assert.match(block, /\n {4}healthcheck:\n/, `${name} has no healthcheck`);
    assert.ok(block.includes(url), `${name} healthcheck does not probe ${url}`);
    assert.match(block, /interval: \d+s/);
    assert.match(block, /timeout: \d+s/);
    assert.match(block, /retries: \d+/);
  }
});

test('the Caddy admin API the healthcheck relies on stays enabled and local', () => {
  // `admin off` 会让 healthcheck 永远失败；把 admin 绑到 0.0.0.0 则会把可改
  // 配置的接口暴露给 compose 网络里的其它容器。默认就是只听 localhost:2019。
  const globalBlock = CADDYFILE.match(/^\{\n([\s\S]*?)\n\}/)[1];
  assert.doesNotMatch(globalBlock, /^\s*admin\b/m);
});
