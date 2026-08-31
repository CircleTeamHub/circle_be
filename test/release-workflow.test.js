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
    assert.match(workflow, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
    const runGate = (target, trusted = '2') => {
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

    assert.equal(runGate('2').status, 0);
    assert.notEqual(runGate('1').status, 0);
    assert.notEqual(runGate(null).status, 0);
    assert.notEqual(runGate('0').status, 0);
    assert.notEqual(runGate('invalid').status, 0);
    assert.notEqual(runGate('2', 'invalid').status, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
