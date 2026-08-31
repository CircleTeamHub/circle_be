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
  for (const operationalFile of [
    'deploy/release-deploy.sh',
    'deploy/app-env-preflight.sh',
    'deploy/Caddyfile.admin',
    'docker-compose.prod.yml',
    'docker-compose.release.yml',
  ]) {
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
      path.join(directory, 'deploy', 'release-deploy.sh'),
      'old deploy\n',
    );
    fs.writeFileSync(
      path.join(directory, 'docker-compose.prod.yml'),
      'old compose\n',
    );
    for (const operationalFile of [
      'deploy/release-deploy.sh',
      'deploy/app-env-preflight.sh',
      'deploy/Caddyfile.admin',
      'docker-compose.prod.yml',
      'docker-compose.release.yml',
    ]) {
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
    assert.match(
      fs.readFileSync(path.join(directory, 'docker-compose.prod.yml'), 'utf8'),
      /group_add:[\s\S]*APP_ENV_GID/,
    );
    assert.equal(
      fs.readFileSync(
        path.join(directory, 'deploy', 'SCHEMA_COMPATIBILITY'),
        'utf8',
      ),
      '0\n',
      'historical schema metadata must remain from the target tag',
    );
    assert.equal(fs.existsSync(trusted), false);
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
