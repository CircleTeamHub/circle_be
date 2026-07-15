import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Caddy routes admin API requests directly to the blue-green backend', () => {
  const caddy = read('deploy/Caddyfile.admin');
  const adminBlock = caddy.slice(caddy.indexOf('{$ADMIN_DOMAIN}'));
  const apiHandler = adminBlock.indexOf('handle /api/*');
  const siteHandler = adminBlock.indexOf('reverse_proxy admin_web:80');

  assert.notEqual(apiHandler, -1, 'ADMIN_DOMAIN must define an /api/* handler');
  assert.ok(apiHandler < siteHandler, 'the API handler must precede the static-site proxy');
  assert.match(adminBlock, /handle \/api\/\*[\s\S]*import backend_proxy/);
});

test('Caddy excludes an unready color from backend traffic', () => {
  const caddy = read('deploy/Caddyfile.admin');
  const productionCompose = read('docker-compose.prod.yml');
  const releaseCompose = read('docker-compose.release.yml');

  assert.doesNotMatch(productionCompose, /circle-be-app/);
  assert.doesNotMatch(releaseCompose, /circle-be-app/);
  assert.match(productionCompose, /container_name:\s*circle-be-blue/);
  assert.match(releaseCompose, /circle_be_green:[\s\S]*container_name:\s*circle-be-green/);
  assert.match(
    caddy,
    /reverse_proxy \{\$BACKEND_UPSTREAMS:circle-be-blue:3000 circle-be-green:3000\}/,
  );
  assert.match(caddy, /lb_policy first/);
  assert.match(caddy, /health_uri \/api\/v1\/outbox\/health/);
  assert.match(caddy, /health_status 401/);
  assert.doesNotMatch(caddy, /circle-be-app/);
});

test('backend release loads the new Caddy routing before changing app colors', () => {
  const deploy = read('deploy/release-deploy.sh');
  const productionCompose = read('docker-compose.prod.yml');
  const reload = deploy.indexOf('reload_caddy_config');
  const migration = deploy.indexOf('==> Running prisma migrate deploy');

  assert.match(productionCompose, /\.\/deploy:\/etc\/caddy:ro/);
  assert.match(deploy, /compose cp deploy\/Caddyfile\.admin caddy:\/tmp\/Caddyfile\.release/);
  assert.match(deploy, /container_upstream\(\)/);
  assert.match(
    deploy,
    /-e BACKEND_UPSTREAMS="\$upstreams" caddy[\s\\]*caddy validate/,
  );
  assert.match(deploy, /caddy validate --config \/tmp\/Caddyfile\.release --adapter caddyfile/);
  assert.match(deploy, /caddy reload --config \/tmp\/Caddyfile\.release --adapter caddyfile/);
  assert.match(
    deploy,
    /initial_upstream="\$\(container_upstream "\$live"\)"[\s\S]*?if ! reload_caddy_config "\$initial_upstream"; then[\s\S]*?exit 1[\s\S]*?==> Running prisma migrate deploy/,
  );
  assert.match(
    deploy,
    /wait_healthy "\$standby" 300[\s\S]*?reload_caddy_config "\$cutover_upstreams"[\s\S]*?stopping \$live/,
  );
  assert.match(
    deploy,
    /Smoke test failed[\s\S]*?compose start "\$live"[\s\S]*?reload_caddy_config "\$\(container_upstream "\$live"\)"/,
  );
  assert.notEqual(reload, -1, 'release script must reload Caddy');
  assert.ok(reload < migration, 'Caddy must reload before migrations or color changes');
});

test('backend release fails closed when both colors are already running', () => {
  const deploy = read('deploy/release-deploy.sh');
  const bothColors = deploy.slice(
    deploy.indexOf('if [ -n "$blue" ] && [ -n "$green" ]; then'),
    deploy.indexOf('if [ -n "$blue" ]; then'),
  );

  assert.match(bothColors, /interrupted release/);
  assert.match(bothColors, /exit 1/);
  assert.doesNotMatch(bothColors, /compose (?:rm|stop)/);
});

test('backend release SSH setup fails closed without pretrusted host keys', () => {
  const release = read('.github/workflows/release.yml');
  const validation = release.slice(
    release.indexOf('- name: Configure SSH'),
    release.indexOf('mkdir -p ~/.ssh'),
  );

  assert.match(validation, /\[ -z "\$DEPLOY_KNOWN_HOSTS" \]/);
  assert.doesNotMatch(release, /ssh-keyscan/);
});

test('backend release never rebuilds tags and deploys immutable digests', () => {
  const release = read('.github/workflows/release.yml');

  assert.doesNotMatch(release, /docker\/build-push-action/);
  assert.doesNotMatch(release, /^  build:/m);
  assert.match(release, /needs_promotion/);
  assert.match(release, /if: \$\{\{ needs\.resolve\.outputs\.needs_promotion == 'true' \}\}/);
  assert.match(release, /image_ref=\$repo@\$digest/);
  assert.match(release, /CIRCLE_BE_IMAGE: \$\{\{ needs\.resolve\.outputs\.image_ref \}\}/);
});

test('backend release gate actions are pinned to full commit SHAs', () => {
  for (const filename of ['build-image.yml', 'ci.yml', 'release.yml']) {
    const workflow = read(`.github/workflows/${filename}`);
    for (const line of workflow.split(/\r?\n/).filter((item) => /\buses:/.test(item))) {
      assert.match(line, /uses:\s+[^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/i, `${filename}: ${line.trim()}`);
    }
  }
});

test('backend deploy accepts only immutable digests and real API responses', () => {
  const deploy = read('deploy/release-deploy.sh');
  const release = read('.github/workflows/release.yml');

  assert.match(deploy, /CIRCLE_BE_IMAGE.*sha256:\[0-9a-f\]\{64\}/);
  assert.match(deploy, /\[ "\$code" = "401" \]/);
  assert.doesNotMatch(deploy, /2\*\|3\*\|401\|403/);
  assert.doesNotMatch(deploy, /skipping public smoke test/);
  assert.match(release, /API_SMOKE_EXPECTED_STATUS/);
  assert.match(release, /\[ "\$code" = "\$API_SMOKE_EXPECTED_STATUS" \]/);
  assert.match(release, /\[ "\$API_SMOKE_EXPECTED_STATUS" = "404" \]/);
  assert.doesNotMatch(release, /2\*\|3\*\|401\|403/);
});

test('downtime deployment restores the live app after migration or startup failure', () => {
  const deploy = read('deploy/release-deploy.sh');

  assert.match(deploy, /restore_live\(\)/);
  assert.match(deploy, /if ! compose run --rm migrate; then[\s\S]*restore_live/);
  assert.match(deploy, /if ! compose up -d --no-build --no-deps "\$standby"; then[\s\S]*restore_live/);
});

test('admin deploy validates digests, uses strict smoke checks, and rolls back', () => {
  const deploy = read('deploy/admin-web-deploy.sh');

  assert.match(deploy, /ADMIN_WEB_IMAGE.*sha256:\[0-9a-f\]\{64\}/);
  assert.match(deploy, /previous_image=.*\.Config\.Image/);
  assert.match(deploy, /rollback_admin\(\)/);
  assert.match(deploy, /ADMIN_WEB_IMAGE="\$previous_image"/);
  assert.match(deploy, /index:2\*\|index:3\*/);
  assert.match(deploy, /api:401/);
  assert.doesNotMatch(deploy, /api:2\*|api:3\*|api:403|api:404|index:401|index:403/);
  assert.match(deploy, /if ! wait_running/);
  assert.match(deploy, /rollback_admin/);
});

test('backend CI blocks release contract regressions', () => {
  const ci = read('.github/workflows/ci.yml');

  assert.match(ci, /run: node --test scripts\/release-hardening\.test\.mjs/);
});

test('backend workflow and server use the same strict version format', () => {
  const strictVersion = String.raw`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`;

  assert.ok(read('.github/workflows/release.yml').includes(strictVersion));
  assert.ok(read('deploy/release-deploy.sh').includes(strictVersion));
  assert.ok(read('deploy/admin-web-deploy.sh').includes(strictVersion));
});
