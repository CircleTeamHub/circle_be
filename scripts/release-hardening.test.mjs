import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function workflowRunScript(workflow, stepName, nextStepName) {
  const endMarker = nextStepName.startsWith('\n')
    ? nextStepName
    : `- name: ${nextStepName}`;
  const block = workflow.slice(
    workflow.indexOf(`- name: ${stepName}`),
    workflow.indexOf(endMarker),
  );
  const runMarker = '        run: |\n';
  return {
    block,
    script: block
      .slice(block.indexOf(runMarker) + runMarker.length)
      .split(/\r?\n/)
      .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
      .join('\n'),
  };
}

test('Caddy routes requests only to healthy blue-green backends', () => {
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

test('production carries no OpenIM routing or env residue (self-hosted chat)', () => {
  const compose = read('docker-compose.prod.yml');
  const exampleEnv = read('.env.production.example');
  const caddy = read('deploy/Caddyfile.admin');

  // 自研 chat 网关随 circle_be 同端口(/chat-ws),API 域 catch-all 反代即覆盖,
  // 不允许再出现独立的 OpenIM 路由/上游/环境变量。
  assert.doesNotMatch(caddy, /openim/i);
  assert.doesNotMatch(compose, /OPENIM|host\.docker\.internal/);
  assert.doesNotMatch(exampleEnv, /OPENIM/);
  // API 域的 catch-all 必须落到 circle_be。不再要求 reverse_proxy 紧跟 handle：
  // #137 在这个块里加了 api_fallback 限流,中间隔着 rate_limit —— 断言的意图是
  // 「兜底指向自研后端」,不是「块里除了反代什么都不许有」。
  const apiFallbackHandle =
    /handle \{[^}]*zone api_fallback \{[\s\S]{0,200}?reverse_proxy \{\$CIRCLE_BE_UPSTREAM:circle-be-blue:3000\}/;
  assert.match(caddy, apiFallbackHandle);
});

test('non-root app can read the group-protected production env file', () => {
  const compose = read('docker-compose.prod.yml');
  const generator = read('deploy/gen-env.sh');
  const release = read('deploy/release-deploy.sh');
  const preflight = read('deploy/app-env-preflight.sh');

  assert.match(compose, /group_add:[\s\S]*APP_ENV_GID/);
  assert.match(generator, /validate_private_gid "\$DEPLOY_APP_ENV_GID"/);
  assert.match(generator, /APP_ENV_GID=\$DEPLOY_APP_ENV_GID/);
  assert.match(generator, /chgrp "\$DEPLOY_APP_ENV_GID" \.env\.production/);
  assert.match(generator, /setfacl -b "\$file"/);
  assert.match(
    generator,
    /prepare_empty_secret_file \.env\.production\.tmp[\s\S]*chgrp "\$DEPLOY_APP_ENV_GID" \.env\.production\.tmp[\s\S]*chmod 640 \.env\.production\.tmp[\s\S]*mv \.env\.production\.tmp \.env\.production/,
  );
  assert.match(release, /prepare_compose_app_env_gid "\$COMPOSE_ENV_FILE"/);
  assert.match(preflight, /expected_gid="\$\(id -g "\$deploy_user"\)"/);
  assert.match(
    preflight,
    /validate_private_app_env_gid "\$deploy_user" "\$configured_gid"/,
  );
  assert.match(
    release,
    /: > "\$app_env_staged_file"[\s\S]*clear_app_env_acl "\$app_env_staged_file"[\s\S]*cat "\$legacy_app_env_backup" > "\$app_env_staged_file"[\s\S]*chgrp "\$resolved_app_env_gid" "\$app_env_staged_file"[\s\S]*chmod 640 "\$app_env_staged_file"[\s\S]*mv "\$app_env_staged_file" "\$APP_ENV_FILE"/,
  );
  assert.match(
    release,
    /awk -v key=[\s\S]*chgrp "\$gid" "\$tmp"[\s\S]*clear_app_env_acl "\$tmp"[\s\S]*chmod 640 "\$tmp"[\s\S]*mv "\$tmp" "\$file"/,
  );
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

test('blue-green services do not share a Docker DNS alias', () => {
  const prod = read('docker-compose.prod.yml');
  const release = read('docker-compose.release.yml');

  assert.doesNotMatch(prod, /circle-be-app/);
  assert.doesNotMatch(release, /circle-be-app/);
  assert.doesNotMatch(release, /aliases:/);
});

test('proxy switches validate the selected upstream before reloading Caddy', () => {
  const deploy = read('deploy/release-deploy.sh');
  const switchProxy = deploy.slice(
    deploy.indexOf('switch_proxy()'),
    deploy.indexOf('if [ -n "${GHCR_TOKEN:-}" ]'),
  );
  const validate = switchProxy.indexOf('caddy validate');
  const reload = switchProxy.indexOf('caddy reload');

  assert.notEqual(validate, -1);
  assert.notEqual(reload, -1);
  assert.ok(validate < reload);
  assert.match(switchProxy, /CIRCLE_BE_UPSTREAM=\$target/);
  assert.match(
    switchProxy,
    /if ! compose exec[\s\S]*caddy validate[\s\S]*return 1/,
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

test('the configured single-platform release image is scanned before either registry push', () => {
  const workflow = read('.github/workflows/build-image.yml');
  const build = workflow.indexOf('- name: Build and load release image');
  const scan = workflow.indexOf('- name: Scan releasable image');
  const push = workflow.indexOf('- name: Push scanned image tags');

  assert.match(workflow, /linux\/amd64\|linux\/arm64/);
  assert.match(workflow, /platforms: \$\{\{ steps\.meta\.outputs\.platform \}\}/);
  assert.match(workflow, /push: false/);
  assert.match(workflow, /load: true/);
  assert.match(
    workflow,
    /aquasecurity\/trivy-action@a9c7b0f06e461e9d4b4d1711f154ee024b8d7ab8/,
  );
  assert.match(
    workflow,
    /image-ref: \$\{\{ steps\.meta\.outputs\.repo \}\}:sha-\$\{\{ github\.sha \}\}-\$\{\{ steps\.meta\.outputs\.arch \}\}/,
  );
  assert.ok(
    build >= 0 && build < scan,
    'the release image must be built before scanning',
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

test('downtime deployment restores the live app after migration or reversible startup failure', () => {
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

test('marked releases reject tag push and incomplete manual confirmations', (t) => {
  const release = read('.github/workflows/release.yml');
  const { block: gate, script } = workflowRunScript(
    release,
    'Validate irreversible migration confirmations',
    'Notify release start',
  );
  const directory = mkdtempSync(join(tmpdir(), 'circle-release-gate-'));
  mkdirSync(join(directory, 'deploy'));
  writeFileSync(
    join(directory, 'deploy', 'REQUIRES_IRREVERSIBLE_MIGRATION'),
    'test marker\n',
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const runGate = (EVENT_NAME, DOWNTIME, IRREVERSIBLE) =>
    spawnSync('/bin/bash', ['-c', script], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, EVENT_NAME, DOWNTIME, IRREVERSIBLE },
    });

  assert.match(gate, /deploy\/REQUIRES_IRREVERSIBLE_MIGRATION/);
  assert.notEqual(runGate('push', 'false', 'false').status, 0);
  for (const confirmations of [
    ['false', 'false'],
    ['true', 'false'],
    ['false', 'true'],
  ]) {
    assert.notEqual(
      runGate('workflow_dispatch', ...confirmations).status,
      0,
      `manual dispatch unexpectedly accepted ${confirmations.join('/')}`,
    );
  }
  assert.equal(runGate('workflow_dispatch', 'true', 'true').status, 0);
  assert.match(
    release,
    /RELEASE_IRREVERSIBLE_MIGRATION: \$\{\{ inputs\.irreversible_migration && '1' \|\| '0' \}\}/,
  );
});

test('manual dispatch promotes the commit image when the version image is absent', (t) => {
  const release = read('.github/workflows/release.yml');
  const { script: workflowScript } = workflowRunScript(
    release,
    'Resolve immutable image',
    '\n  promote:',
  );
  const script = workflowScript.replace(
    '${GITHUB_REPOSITORY,,}',
    '$GITHUB_REPOSITORY',
  );
  const directory = mkdtempSync(join(tmpdir(), 'circle-release-image-'));
  const bin = join(directory, 'bin');
  const output = join(directory, 'output');
  mkdirSync(bin);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
if [ "$1" = "login" ]; then exit 0; fi
ref="$4"
case "$ref" in
  *:sha-*) printf '{"digest":"sha256:%064d"}\\n' 0 ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);

  const result = spawnSync('/bin/bash', ['-c', script], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      EVENT_NAME: 'workflow_dispatch',
      SHA: 'a'.repeat(40),
      RELEASE_TAG: 'v1.2.3',
      GHCR_TOKEN: 'token',
      RELEASE_PLATFORM: 'linux/arm64',
      GITHUB_REPOSITORY: 'circleteamhub/circle_be',
      GITHUB_ACTOR: 'release-test',
      GITHUB_OUTPUT: output,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const outputs = readFileSync(output, 'utf8');
  assert.match(outputs, /digest=sha256:0{64}/);
  assert.match(outputs, /needs_promotion=true/);
  assert.match(outputs, /sha_image=.*:sha-a{40}-arm64/);
  assert.match(outputs, /release_image=.*:v1\.2\.3-arm64/);
  assert.match(outputs, /image_ref=ghcr\.io\/circleteamhub\/circle_be@sha256:0{64}/);
});

test('platform changes cannot overwrite commit or version image tags', () => {
  const build = read('.github/workflows/build-image.yml');
  const release = read('.github/workflows/release.yml');

  assert.match(build, /sha-\$\{\{ github\.sha \}\}-\$\{\{ steps\.meta\.outputs\.arch \}\}/);
  assert.match(build, /main-\$\{\{ steps\.meta\.outputs\.arch \}\}/);
  assert.match(release, /sha_image="\$repo:sha-\$SHA-\$arch"/);
  assert.match(release, /release_image="\$repo:\$RELEASE_TAG-\$arch"/);

  const sha = 'a'.repeat(40);
  const refs = ['arm64', 'amd64'].map((arch) => ({
    commit: `sha-${sha}-${arch}`,
    version: `v1.2.3-${arch}`,
  }));
  assert.notEqual(refs[0].commit, refs[1].commit);
  assert.notEqual(refs[0].version, refs[1].version);
});

test('manual dispatch accepts only platform-compatible legacy image tags', (t) => {
  const release = read('.github/workflows/release.yml');
  const { script: workflowScript } = workflowRunScript(
    release,
    'Resolve immutable image',
    '\n  promote:',
  );
  const script = workflowScript.replace(
    '${GITHUB_REPOSITORY,,}',
    '$GITHUB_REPOSITORY',
  );
  const directory = mkdtempSync(join(tmpdir(), 'circle-legacy-release-image-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sha = 'a'.repeat(40);

  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
if [ "$1" = "login" ]; then exit 0; fi
ref="$4"
format="$6"
case "$ref" in
  *:v1.2.3|*:sha-${sha}) ;;
  *) exit 1 ;;
esac
case "$format" in
  *Image*) printf '{"os":"linux","architecture":"%s"}\n' "\${LEGACY_ARCH:-arm64}" ;;
  *) printf '{"digest":"sha256:%064d"}\n' 7 ;;
esac
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);

  const run = (legacyArch, outputName) =>
    spawnSync('/bin/bash', ['-c', script], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        EVENT_NAME: 'workflow_dispatch',
        SHA: sha,
        RELEASE_TAG: 'v1.2.3',
        GHCR_TOKEN: 'token',
        RELEASE_PLATFORM: 'linux/arm64',
        LEGACY_ARCH: legacyArch,
        GITHUB_REPOSITORY: 'circleteamhub/circle_be',
        GITHUB_ACTOR: 'release-test',
        GITHUB_OUTPUT: join(directory, outputName),
      },
    });

  const compatible = run('arm64', 'compatible-output');
  assert.equal(compatible.status, 0, compatible.stderr);
  const outputs = readFileSync(join(directory, 'compatible-output'), 'utf8');
  assert.match(outputs, /release_image=.*:v1\.2\.3$/m);
  assert.match(outputs, /needs_promotion=false/);

  const incompatible = run('amd64', 'incompatible-output');
  assert.notEqual(incompatible.status, 0);
  assert.match(incompatible.stderr, /is linux\/amd64, expected linux\/arm64/);
});

test('workflow stages and activates only through the restricted release protocol', () => {
  const release = read('.github/workflows/release.yml');
  // v2:归档走 stdin,身份与参数走一份离线签名的 manifest（见下面的签名断言）。
  assert.match(
    release,
    /circle-release stage-v2 \$STAGED_RELEASE_NAME \$manifest_b64 \$signature_b64/,
  );
  assert.match(release, /circle-release activate-v2 \$STAGED_RELEASE_NAME/);
  // 签名是这一版的信任根:少了它,服务器只能凭"谁连上来"判断发布包真伪。
  assert.match(release, /openssl dgst -sha256 -sign/);
  assert.match(release, /archive_sha256=/);
  // 签名不带新鲜度就等于永久有效:旧的 (manifest, 签名, 归档) 可被重放降级。
  assert.match(release, /issued_at=/);
  const gate = read('deploy/release-force-command.sh');
  assert.match(gate, /assert_manifest_fresh/);
  assert.match(gate, /MANIFEST_MAX_AGE_SECONDS/);
  assert.doesNotMatch(release, /ssh[^\n]*bash -s/);
  assert.doesNotMatch(release, /rsync[\s\S]*ssh -i/);
  assert.doesNotMatch(release, /Install persistent release launcher/);
});

test('server ForceCommand accepts no general shell or launcher replacement command', () => {
  const gate = read('deploy/release-force-command.sh');
  assert.match(gate, /SSH_ORIGINAL_COMMAND/);
  assert.match(gate, /command_parts\[0\].*circle-release/);
  assert.match(gate, /stage-v2\) stage_release/);
  assert.match(gate, /activate-v2\) activate_release/);
  assert.match(gate, /! -w "\$LAUNCHER"/);
  assert.match(gate, /exec env -i/);
  assert.doesNotMatch(gate, /eval /);
  assert.doesNotMatch(gate, /bash -c/);
  assert.doesNotMatch(gate, /install-launcher/);
});

test('persistent launcher holds one lock across floor check, activation, and target execution', () => {
  const launcher = read('deploy/release-launcher.sh');
  const lock = launcher.indexOf('flock -x 201');
  const floor = launcher.indexOf(
    'cat "$MINIMUM_SCHEMA_COMPATIBILITY_PATH"',
    lock,
  );
  const activation = launcher.indexOf('rsync ', floor);
  const target = launcher.indexOf('bash deploy/release-deploy.sh', activation);

  assert.match(launcher, /exec 201>"\$RELEASE_STATE_DIR\/deploy\.lock"/);
  assert.ok(lock >= 0 && lock < floor);
  assert.ok(floor < activation);
  assert.ok(activation < target);
  assert.doesNotMatch(launcher.slice(lock, target), /flock -u/);
});

test('server crosses an explicit no-rollback boundary after irreversible migration', () => {
  const deploy = read('deploy/release-deploy.sh');
  const migration = deploy.indexOf('if ! compose run --rm migrate; then');
  const crossed = deploy.indexOf('irreversible_migration_applied=1', migration);

  assert.match(
    deploy,
    /RELEASE_IRREVERSIBLE_MIGRATION.*requires RELEASE_DOWNTIME=1/,
  );
  assert.match(
    deploy,
    /REQUIRES_IRREVERSIBLE_MIGRATION.*RELEASE_IRREVERSIBLE_MIGRATION=1/s,
  );
  assert.ok(migration >= 0 && migration < crossed);
  assert.match(deploy, /enter_irreversible_maintenance\(\)/);
  assert.match(deploy, /pg_constraint/);
  assert.match(deploy, /User_vipLevel_check/);
  assert.match(deploy, /Circle_joinVipRestriction_check/);
  assert.match(deploy, /CirclePost_vipRestriction_check/);
  assert.match(deploy, /CirclePost_signupVipRestriction_check/);
  assert.match(
    deploy,
    /if ! compose run --rm migrate; then[\s\S]*handle_irreversible_migration_command_failure/,
  );
  assert.match(
    deploy,
    /unapplied\)[\s\S]*restore_live[\s\S]*applied\)[\s\S]*enter_irreversible_maintenance/,
  );
  assert.match(
    deploy,
    /if irreversible_boundary_crossed; then[\s\S]*enter_irreversible_maintenance/,
  );
  assert.match(deploy, /minimum-schema-compatibility/);
  assert.match(deploy, /schema compatibility.*below server minimum/);
});

test('admin deploy validates digests, backfills legacy env, uses strict smoke checks, and rolls back', (t) => {
  const deploy = read('deploy/admin-web-deploy.sh');
  const preflightPath = fileURLToPath(
    new URL('../deploy/app-env-preflight.sh', import.meta.url),
  );

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
  const preflight = deploy.indexOf(
    'prepare_compose_app_env_gid "$COMPOSE_ENV_FILE"',
  );
  const firstCompose = deploy.indexOf('previous_container_id="$(compose ps');
  assert.ok(preflight >= 0 && preflight < firstCompose);

  if (process.platform !== 'win32') {
    const directory = mkdtempSync(join(tmpdir(), 'circle-admin-preflight-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const composeEnv = join(directory, '.env');
    writeFileSync(composeEnv, 'DB_PASSWORD=test-only\n', { mode: 0o600 });
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        '. "$PREFLIGHT"; resolved_app_env_gid=""; prepare_compose_app_env_gid "$COMPOSE_ENV_FILE"; printf "validated=%s\\n" "$APP_ENV_GID"',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PREFLIGHT: preflightPath,
          COMPOSE_ENV_FILE: composeEnv,
          APP_ENV_GID: '999999',
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const configuredGid = readFileSync(composeEnv, 'utf8').match(
      /^APP_ENV_GID=(\d+)$/m,
    )?.[1];
    assert.ok(configuredGid);
    assert.match(result.stdout, new RegExp(`validated=${configuredGid}\\n$`));
  }
});

test('backend CI blocks release contract regressions', () => {
  const ci = read('.github/workflows/ci.yml');

  assert.match(ci, /node --test scripts\/release-hardening\.test\.mjs/);
  assert.match(ci, /bash test\/release-deploy\.spec\.sh/);
  assert.match(ci, /bash test\/release-launcher\.spec\.sh/);
  assert.match(ci, /bash test\/release-force-command\.spec\.sh/);
});

test('every main push creates the exact-SHA CI run required by release', () => {
  const ci = read('.github/workflows/ci.yml');
  const push = ci.slice(ci.indexOf('  push:'), ci.indexOf('  pull_request:'));
  const pullRequest = ci.slice(
    ci.indexOf('  pull_request:'),
    ci.indexOf('\n# Cancel superseded runs'),
  );

  assert.match(push, /branches:\s*\n\s*- main/);
  assert.doesNotMatch(push, /paths-ignore:/);
  assert.match(pullRequest, /paths-ignore:/);
});

test('the mounted Caddy entrypoint is always checked out with Linux line endings', () => {
  const attributes = read('.gitattributes');

  assert.match(attributes, /^deploy\/caddy-entrypoint\.sh text eol=lf$/m);
});

test('release selection and active-color state fail closed', () => {
  const release = read('.github/workflows/release.yml');
  const deploy = read('deploy/release-deploy.sh');
  const compose = read('docker-compose.prod.yml');
  const caddyEntrypoint = read('deploy/caddy-entrypoint.sh');

  assert.match(
    release,
    /head_sha=\$SHA&event=push&branch=main&status=completed/,
  );
  assert.match(release, /--exclude=\.\/\.release/);
  assert.match(deploy, /recorded_live_color\(\)/);
  assert.match(deploy, /Refusing to guess which container is live/);
  assert.match(deploy, /caddy reload --config \/etc\/caddy\/Caddyfile/);
  assert.match(deploy, /caddy validate --config \/etc\/caddy\/Caddyfile/);
  assert.match(
    compose,
    /caddy-entrypoint\.sh:\/usr\/local\/bin\/caddy-entrypoint\.sh:ro/,
  );
  assert.match(
    compose,
    /entrypoint: \['\/bin\/sh', '\/usr\/local\/bin\/caddy-entrypoint\.sh'\]/,
  );
  assert.doesNotMatch(compose, /caddy run --resume/);
  assert.match(caddyEntrypoint, /circle-be-\(blue\|green\):3000/);
  assert.match(caddyEntrypoint, /export CIRCLE_BE_UPSTREAM=/);
  assert.match(
    caddyEntrypoint,
    /exec caddy run --config \/etc\/caddy\/Caddyfile --adapter caddyfile/,
  );
  assert.doesNotMatch(caddyEntrypoint, /caddy run --resume/);
});

test('Caddy restart preserves only the active upstream and loads the current Caddyfile', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'circle-caddy-'));
  const autosave = join(directory, 'autosave.json');
  const fakeCaddy = join(directory, 'caddy');
  const entrypoint = fileURLToPath(
    new URL('../deploy/caddy-entrypoint.sh', import.meta.url),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  writeFileSync(
    autosave,
    JSON.stringify({ upstreams: ['circle-be-green:3000'] }),
  );
  writeFileSync(
    fakeCaddy,
    '#!/bin/sh\nprintf "%s|%s\\n" "$CIRCLE_BE_UPSTREAM" "$*"\n',
  );
  chmodSync(fakeCaddy, 0o755);

  const result = spawnSync('/bin/sh', [entrypoint], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CADDY_AUTOSAVE_FILE: autosave,
      PATH: `${directory}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    'circle-be-green:3000|run --config /etc/caddy/Caddyfile --adapter caddyfile',
  );

  writeFileSync(autosave, JSON.stringify({ upstreams: ['unknown:3000'] }));
  const invalid = spawnSync('/bin/sh', [entrypoint], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CADDY_AUTOSAVE_FILE: autosave,
      PATH: `${directory}:${process.env.PATH}`,
    },
  });

  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /does not identify the active blue\/green backend/);
});

test('backend workflow and server use the same strict version format', () => {
  const strictVersion = String.raw`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`;

  assert.ok(read('.github/workflows/release.yml').includes(strictVersion));
  assert.ok(read('deploy/release-deploy.sh').includes(strictVersion));
  assert.ok(read('deploy/admin-web-deploy.sh').includes(strictVersion));
});

// note-exports/ 的生命周期规则是它唯一的回收机制,而它挂在一次性的 minio-init 上,
// 发版又不碰数据面(release-deploy.sh 契约 / DEPLOY.md §4)—— 存量环境升级后根本
// 执行不到它。所以 entrypoint 必须可重复执行,且必须有一条文档化的补齐步骤,
// 否则导出产物会一直堆到和 Postgres 同机的磁盘写满。
test('note-exports lifecycle rule is re-appliable and has a documented rollout', () => {
  const compose = read('docker-compose.prod.yml');
  const deployDoc = read('DEPLOY.md');

  // 幂等:先查后加。直接 add 会在重复执行时把规则叠一遍。
  assert.match(compose, /mc ilm rule ls local\/circle .*\| grep -q 'note-exports\/'/);
  assert.match(
    compose,
    /mc ilm rule add --expire-days 1 --prefix 'note-exports\/' local\/circle/,
  );
  // 装完必须自检并在失败时明确告警,不能静默地"看起来成功"。
  assert.match(compose, /note-exports lifecycle rule is NOT active/);
  // 存量环境的补齐步骤必须写进 DEPLOY.md,否则老环境永远拿不到这条规则。
  assert.match(
    deployDoc,
    /docker compose -f docker-compose\.prod\.yml run --rm minio-init/,
  );
});
