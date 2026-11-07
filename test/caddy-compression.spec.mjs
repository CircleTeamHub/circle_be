import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CADDYFILE = readFileSync(join(ROOT, 'deploy/Caddyfile.admin'), 'utf8').replace(/\r\n/g, '\n');

// 顶层站点块：从「{$X_DOMAIN} {」到第一行只有「}」的地方。
function siteBlock(name) {
  const match = CADDYFILE.match(new RegExp(`^\\{\\$${name}\\} \\{\\n([\\s\\S]*?)\\n\\}`, 'm'));
  assert.ok(match, `${name} site block missing`);
  return match[1];
}

// 2026-11 国内测试机连新加坡：线路一丢包，TCP 就降速等重传，传的字节越多越慢。接口 JSON 原样
// 传输（Caddy 和后端都没开压缩），压缩后通常只剩一到三成。
for (const name of ['API_DOMAIN', 'ADMIN_DOMAIN']) {
  test(`${name} compresses responses with zstd and gzip`, () => {
    assert.match(siteBlock(name), /^\tencode zstd gzip$/m);
  });
}
