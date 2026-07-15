import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Caddy routes admin API requests directly to the blue-green backend', () => {
  const caddy = read('deploy/Caddyfile.admin');
  const adminBlock = caddy.slice(caddy.indexOf('{$ADMIN_DOMAIN}'));
  const apiHandler = adminBlock.indexOf('handle /api/*');
  const siteHandler = adminBlock.indexOf('reverse_proxy admin_web:80');

  assert.notEqual(apiHandler, -1, 'ADMIN_DOMAIN must define an /api/* handler');
  assert.ok(
    apiHandler < siteHandler,
    'the API handler must precede the static-site proxy',
  );
  assert.match(
    adminBlock,
    /handle \/api\/\*[\s\S]*reverse_proxy \{\$CIRCLE_BE_UPSTREAM:circle-be-blue:3000\}/,
  );
  assert.doesNotMatch(caddy, /\}:3000/);
});

test('Caddy switches only between unique blue-green container endpoints', () => {
  const caddy = read('deploy/Caddyfile.admin');
  const deploy = read('deploy/release-deploy.sh');
  const productionCompose = read('docker-compose.prod.yml');
  const releaseCompose = read('docker-compose.release.yml');
  const healthGate = deploy.indexOf('if ! wait_healthy "$standby" 300; then');
  const cutover = deploy.indexOf('if ! switch_proxy "$standby"; then');

  assert.doesNotMatch(productionCompose, /circle-be-app/);
  assert.doesNotMatch(releaseCompose, /circle-be-app/);
  assert.doesNotMatch(releaseCompose, /^\s*- circle_be\s*$/m);
  assert.match(productionCompose, /container_name:\s*circle-be-blue/);
  assert.match(
    releaseCompose,
    /circle_be_green:[\s\S]*container_name:\s*circle-be-green/,
  );
  assert.match(caddy, /CIRCLE_BE_UPSTREAM:circle-be-blue/);
  assert.match(deploy, /container_upstream\(\)/);
  assert.match(
    deploy,
    /if ! name="\$\(docker inspect --format '\{\{\.Name\}\}' "\$cid"\)" \|\| \[ -z "\$name" \]; then/,
  );
  assert.match(deploy, /target="\$\(container_upstream "\$1"\)"/);
  assert.ok(
    healthGate >= 0 && healthGate < cutover,
    'standby health must precede cutover',
  );
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
  assert.match(
    release,
    /if: \$\{\{ needs\.resolve\.outputs\.needs_promotion == 'true' \}\}/,
  );
  assert.match(release, /image_ref=\$repo@\$digest/);
  assert.match(
    release,
    /CIRCLE_BE_IMAGE: \$\{\{ needs\.resolve\.outputs\.image_ref \}\}/,
  );
});

test('backend release gate actions are pinned to full commit SHAs', () => {
  for (const filename of ['build-image.yml', 'ci.yml', 'release.yml']) {
    const workflow = read(`.github/workflows/${filename}`);
    for (const line of workflow
      .split(/\r?\n/)
      .filter((item) => /\buses:/.test(item))) {
      assert.match(
        line,
        /uses:\s+[^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/i,
        `${filename}: ${line.trim()}`,
      );
    }
  }
});

test('releasable ARM64 image is scanned before either registry push', () => {
  const workflow = read('.github/workflows/build-image.yml');
  const build = workflow.indexOf('- name: Build and load ARM64 image');
  const scan = workflow.indexOf('- name: Scan releasable ARM64 image');
  const push = workflow.indexOf('- name: Push scanned image tags');

  assert.match(workflow, /platforms: linux\/arm64/);
  assert.match(workflow, /push: false/);
  assert.match(workflow, /load: true/);
  assert.match(
    workflow,
    /aquasecurity\/trivy-action@a9c7b0f06e461e9d4b4d1711f154ee024b8d7ab8/,
  );
  assert.match(
    workflow,
    /image-ref: \$\{\{ steps\.meta\.outputs\.repo \}\}:sha-\$\{\{ github\.sha \}\}/,
  );
  assert.ok(
    build >= 0 && build < scan,
    'the ARM64 image must be built before scanning',
  );
  assert.ok(
    scan < push,
    'the blocking scan must finish before registry pushes',
  );
  assert.doesNotMatch(workflow.slice(0, scan), /push: true|docker push/);
  assert.match(workflow.slice(push), /docker push "\$SHA_IMAGE"/);
  assert.match(workflow.slice(push), /docker push "\$MAIN_IMAGE"/);
});

test('backend deploy accepts only immutable digests and real API responses', () => {
  const deploy = read('deploy/release-deploy.sh');
  const release = read('.github/workflows/release.yml');

  assert.match(deploy, /CIRCLE_BE_IMAGE.*sha256:\[0-9a-f\]\{64\}/);
  assert.match(deploy, /401\|403/);
  assert.match(deploy, /content-type:.*application\/\(problem\\\+\)\?json/i);
  assert.doesNotMatch(deploy, /2\*\|3\*\|401\|403/);
  assert.doesNotMatch(deploy, /401\|403\|404/);
  assert.doesNotMatch(deploy, /skipping public smoke test/);
  assert.match(release, /content-type:.*application\/\(problem\\\+\)\?json/i);
  assert.doesNotMatch(release, /401\|403\|404/);
});

test('downtime deployment restores the live app after migration or startup failure', () => {
  const deploy = read('deploy/release-deploy.sh');

  assert.match(deploy, /restore_live\(\)/);
  assert.match(
    deploy,
    /if ! compose run --rm migrate; then[\s\S]*restore_live/,
  );
  assert.match(
    deploy,
    /if ! compose up -d --no-build --no-deps "\$standby"; then[\s\S]*restore_live/,
  );
});

test('admin deploy validates digests, uses strict smoke checks, and rolls back', () => {
  const deploy = read('deploy/admin-web-deploy.sh');

  assert.match(deploy, /ADMIN_WEB_IMAGE.*sha256:\[0-9a-f\]\{64\}/);
  assert.match(deploy, /previous_image=.*\.Config\.Image/);
  assert.match(deploy, /rollback_admin\(\)/);
  assert.match(deploy, /ADMIN_WEB_IMAGE="\$previous_image"/);
  assert.match(deploy, /index:2\*/);
  assert.match(deploy, /content-type:.*text\/html/i);
  assert.match(deploy, /api:401\|api:403/);
  assert.match(deploy, /content-type:.*application\/\(problem\\\+\)\?json/i);
  assert.doesNotMatch(deploy, /api:2\*/);
  assert.doesNotMatch(deploy, /api:404|index:401|index:403/);
  assert.match(deploy, /if ! wait_running/);
  assert.match(deploy, /rollback_admin/);
});

test('backend CI blocks release contract regressions', () => {
  const ci = read('.github/workflows/ci.yml');

  assert.match(ci, /node --test scripts\/release-hardening\.test\.mjs/);
  assert.match(ci, /bash test\/release-deploy\.spec\.sh/);
});

test('release selection and active-color state fail closed', () => {
  const release = read('.github/workflows/release.yml');
  const deploy = read('deploy/release-deploy.sh');
  const compose = read('docker-compose.prod.yml');

  assert.match(
    release,
    /head_sha=\$SHA&event=push&branch=main&status=completed/,
  );
  assert.match(release, /--exclude=\/\.release/);
  assert.match(deploy, /recorded_live_color\(\)/);
  assert.match(deploy, /Refusing to guess which container is live/);
  assert.match(deploy, /caddy reload --config \/etc\/caddy\/Caddyfile/);
  assert.match(deploy, /caddy validate --config \/etc\/caddy\/Caddyfile/);
  assert.match(compose, /exec caddy run --resume/);
});

test('backend workflow and server use the same strict version format', () => {
  const strictVersion = String.raw`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`;

  assert.ok(read('.github/workflows/release.yml').includes(strictVersion));
  assert.ok(read('deploy/release-deploy.sh').includes(strictVersion));
  assert.ok(read('deploy/admin-web-deploy.sh').includes(strictVersion));
});
