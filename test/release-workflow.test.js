const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

test('release workflow signs and stages the exact immutable release manifest', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  );

  for (const expected of [
    'RELEASE_SIGNING_PRIVATE_KEY: ${{ secrets.RELEASE_SIGNING_PRIVATE_KEY }}',
    'version=2',
    'issued_at=',
    'archive_sha256=',
    'openssl dgst -sha256 -sign',
    'circle-release stage-v2',
    'circle-release activate-v2',
  ]) {
    assert.match(
      workflow,
      new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  }
});

test('manual rollback keeps current trusted deploy tooling with the historical application tag', () => {
  const operationalFiles = [
    'deploy/release-deploy.sh',
    'deploy/admin-web-deploy.sh',
    'deploy/caddy-entrypoint.sh',
    'deploy/overlay-trusted-release-tooling.sh',
    'deploy/app-env-preflight.sh',
    'deploy/offsite-backup.sh',
    'deploy/Caddyfile.admin',
    'Dockerfile.caddy',
    'docker-compose.prod.yml',
    'docker-compose.release.yml',
    'docker-compose.admin-release.yml',
  ];
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  const trustedCheckout = workflow.indexOf(
    '- name: Checkout trusted deployment tooling for manual rollback',
  );
  const overlay = workflow.indexOf(
    '- name: Overlay trusted deployment tooling for manual rollback',
  );
  const archive = workflow.indexOf('tar -czf "$archive"');
  const block = workflow.slice(trustedCheckout, archive);

  assert.ok(trustedCheckout >= 0 && trustedCheckout < overlay);
  assert.ok(
    overlay < archive,
    'trusted tooling must be overlaid before staging',
  );
  assert.match(
    block,
    /if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/,
  );
  assert.match(block, /ref: \$\{\{ needs\.resolve\.outputs\.main_sha \}\}/);
  for (const operationalFile of operationalFiles) {
    assert.match(block, new RegExp(operationalFile.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(
    block,
    /trusted-release-tooling\/deploy\/SCHEMA_COMPATIBILITY/,
  );

  const compose = fs.readFileSync(
    path.join(__dirname, '..', 'docker-compose.prod.yml'),
    'utf8',
  );
  assert.match(compose, /group_add:[\s\S]*APP_ENV_GID/);

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'circle-historical-rollback-'),
  );
  try {
    const trusted = path.join(directory, '.trusted-release-tooling');
    fs.mkdirSync(path.join(directory, 'deploy'), { recursive: true });
    fs.mkdirSync(path.join(trusted, 'deploy'), { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'deploy', 'SCHEMA_COMPATIBILITY'),
      '0\n',
    );
    fs.writeFileSync(
      path.join(directory, 'deploy', 'RELEASE_RUNTIME_COMPATIBILITY'),
      '1\n',
    );
    for (const operationalFile of operationalFiles) {
      if (operationalFile === 'deploy/caddy-entrypoint.sh') continue;
      const historical = path.join(directory, operationalFile);
      fs.mkdirSync(path.dirname(historical), { recursive: true });
      fs.writeFileSync(historical, `historical:${operationalFile}\n`);
      fs.chmodSync(historical, 0o600);
    }
    assert.equal(
      fs.existsSync(path.join(directory, 'deploy', 'caddy-entrypoint.sh')),
      false,
      'historical tree should model a tag from before the Caddy entrypoint existed',
    );
    for (const operationalFile of operationalFiles) {
      const destination = path.join(trusted, operationalFile);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', operationalFile), destination);
    }

    const overlayBlock = workflow.slice(
      overlay,
      workflow.indexOf('- name: Configure SSH'),
    );
    const script = overlayBlock
      .slice(
        overlayBlock.indexOf('        run: |\n') + '        run: |\n'.length,
      )
      .split(/\r?\n/)
      .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
      .join('\n');
    const result = spawnSync('/bin/bash', ['-c', script], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    for (const operationalFile of operationalFiles) {
      const installed = path.join(directory, operationalFile);
      const source = path.join(__dirname, '..', operationalFile);
      assert.deepEqual(
        fs.readFileSync(installed),
        fs.readFileSync(source),
        `${operationalFile} must come from the trusted source`,
      );
      const expectedMode = [
        'deploy/release-deploy.sh',
        'deploy/admin-web-deploy.sh',
        'deploy/caddy-entrypoint.sh',
        'deploy/overlay-trusted-release-tooling.sh',
      ].includes(operationalFile)
        ? 0o755
        : 0o644;
      assert.equal(
        fs.statSync(installed).mode & 0o777,
        expectedMode,
        `${operationalFile} must have its operational mode`,
      );
    }
    assert.match(
      fs.readFileSync(path.join(directory, 'docker-compose.prod.yml'), 'utf8'),
      /group_add:[\s\S]*APP_ENV_GID/,
    );
    assert.equal(
      fs.existsSync(path.join(directory, 'deploy', 'caddy-entrypoint.sh')),
      true,
      'current Compose must never be staged without its entrypoint',
    );
    fs.accessSync(
      path.join(directory, 'deploy', 'caddy-entrypoint.sh'),
      fs.constants.X_OK,
    );
    assert.equal(
      fs.readFileSync(
        path.join(directory, 'deploy', 'SCHEMA_COMPATIBILITY'),
        'utf8',
      ),
      '0\n',
      'historical schema metadata must remain from the target tag',
    );
    assert.equal(
      fs.readFileSync(
        path.join(directory, 'deploy', 'RELEASE_RUNTIME_COMPATIBILITY'),
        'utf8',
      ),
      '1\n',
      'historical runtime compatibility metadata must remain from the target tag',
    );
    assert.equal(fs.existsSync(trusted), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('documented offline rollback overlays live trusted tooling before activation', () => {
  const deploymentGuide = fs.readFileSync(
    path.join(__dirname, '..', 'DEPLOY.md'),
    'utf8',
  );
  const offlineStart = deploymentGuide.indexOf(
    '- **服务器上手动**(GitHub 不可用时)',
  );
  const databaseStart = deploymentGuide.indexOf('- **数据库**:', offlineStart);
  const offline = deploymentGuide.slice(offlineStart, databaseStart);
  const overlay = offline.indexOf(
    'bash deploy/overlay-trusted-release-tooling.sh . ".release/incoming/$stage"',
  );
  const activation = offline.indexOf(
    'bash .release/release-launcher.sh "$stage"',
  );

  assert.ok(offlineStart >= 0 && databaseStart > offlineStart);
  assert.ok(overlay >= 0 && overlay < activation);
  assert.match(offline, /```bash\s+set -euo pipefail/);
  assert.match(offline, /不要从历史 checkout 运行同名脚本/);

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'circle-offline-rollback-failure-'),
  );
  try {
    const target = path.join(directory, 'target');
    const launcher = path.join(directory, 'release-launcher.sh');
    const sentinel = path.join(directory, 'launcher-ran');
    fs.mkdirSync(target);
    fs.writeFileSync(
      launcher,
      '#!/usr/bin/env bash\n: > "$LAUNCHER_SENTINEL"\n',
    );
    fs.chmodSync(launcher, 0o755);
    const helper = path.join(
      __dirname,
      '..',
      'deploy',
      'overlay-trusted-release-tooling.sh',
    );
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        'set -euo pipefail\nbash "$HELPER" "$MISSING_SOURCE" "$TARGET"\nbash "$LAUNCHER"',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HELPER: helper,
          MISSING_SOURCE: path.join(directory, 'missing'),
          TARGET: target,
          LAUNCHER: launcher,
          LAUNCHER_SENTINEL: sentinel,
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.equal(
      fs.existsSync(sentinel),
      false,
      'offline activation must not run after a partial tooling overlay',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('manual rollback rejects application tags below the trusted runtime contract', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  const gate = workflow.indexOf(
    '- name: Verify manual rollback runtime compatibility',
  );
  const nextStep = workflow.indexOf(
    '- name: Verify CI succeeded for this commit',
    gate,
  );
  const block = workflow.slice(gate, nextStep);
  assert.ok(gate >= 0 && nextStep > gate);
  assert.match(
    block,
    /if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/,
  );
  assert.doesNotMatch(block, /inputs\.force/);

  const script = block
    .slice(block.indexOf('        run: |\n') + '        run: |\n'.length)
    .split(/\r?\n/)
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'circle-runtime-contract-'),
  );
  try {
    const bin = path.join(directory, 'bin');
    const deploy = path.join(directory, 'deploy');
    fs.mkdirSync(bin);
    fs.mkdirSync(deploy);
    const git = path.join(bin, 'git');
    fs.writeFileSync(
      git,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$TRUSTED_RUNTIME"\n',
    );
    fs.chmodSync(git, 0o755);
    const runGate = (target, trusted = '1') => {
      const targetFile = path.join(deploy, 'RELEASE_RUNTIME_COMPATIBILITY');
      if (target === null) fs.rmSync(targetFile, { force: true });
      else fs.writeFileSync(targetFile, `${target}\n`);
      return spawnSync('/bin/bash', ['-c', script], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TRUSTED_RUNTIME: trusted,
        },
      });
    };

    assert.equal(runGate('1').status, 0);
    assert.notEqual(runGate(null).status, 0);
    assert.notEqual(runGate('0').status, 0);
    assert.notEqual(runGate('invalid').status, 0);
    assert.notEqual(runGate('1', 'invalid').status, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('manual rollback refuses unverified main deployment tooling even when target CI is forced', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  const gate = workflow.indexOf(
    '- name: Verify CI succeeded for trusted deployment tooling',
  );
  const resolver = workflow.indexOf('- name: Resolve immutable image');
  assert.ok(gate >= 0 && gate < resolver);

  const block = workflow.slice(gate, resolver);
  assert.match(
    block,
    /if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/,
  );
  assert.doesNotMatch(block, /inputs\.force/);
  assert.match(block, /SHA: \$\{\{ steps\.verify\.outputs\.main_sha \}\}/);

  const script = block
    .slice(block.indexOf('        run: |\n') + '        run: |\n'.length)
    .split(/\r?\n/)
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'circle-main-tooling-ci-'),
  );
  try {
    const gh = path.join(directory, 'gh');
    fs.writeFileSync(gh, '#!/usr/bin/env bash\nprintf "%s\\n" "$CI_CONCLUSION"\n');
    fs.chmodSync(gh, 0o755);
    const runGate = (conclusion) =>
      spawnSync('/bin/bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          CI_CONCLUSION: conclusion,
          GITHUB_REPOSITORY: 'CircleTeamHub/circle_be',
          SHA: '0123456789abcdef0123456789abcdef01234567',
        },
      });

    assert.equal(runGate('success').status, 0);
    for (const conclusion of ['', 'pending', 'failure']) {
      const result = runGate(conclusion);
      assert.notEqual(result.status, 0, `must reject ${conclusion || 'missing'} CI`);
      assert.match(result.stderr, /trusted deployment tooling/);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
