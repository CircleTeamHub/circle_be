import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const helper = path.join(repo, 'deploy/migration-baseline.sh').replaceAll('\\', '/');
const run = (script, cwd, env = {}) => spawnSync(bash, ['-c', script], {
  cwd, encoding: 'utf8', env: { ...process.env, ...env },
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-baseline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries({
    'prisma/migrations/001/migration.sql': 'CREATE TABLE first(id INT);\n',
    'prisma/migrations/migration_lock.toml': 'provider = "postgresql"\n',
    'prisma/schema.prisma': 'model First {}\n',
    'deploy/SCHEMA_COMPATIBILITY': '1\n',
    'deploy/REQUIRES_IRREVERSIBLE_MIGRATION': 'historical\n',
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}
function digest(root) {
  return run(`bash "${helper}" digest .`, root);
}

test('digest is stable across roots and ignores application code', (t) => {
  const a = fixture(t), b = fixture(t);
  const first = digest(a);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^[0-9a-f]{64}\n$/);
  assert.equal(digest(b).stdout, first.stdout);
  fs.writeFileSync(path.join(b, 'app.ts'), 'changed app\n');
  assert.equal(digest(b).stdout, first.stdout);
  assert.equal(run(`. "${helper}"`, a).stdout, '');
});

for (const [name, mutate] of Object.entries({
  'SQL edit': (r) => fs.appendFileSync(path.join(r, 'prisma/migrations/001/migration.sql'), '-- edit\n'),
  'file removal': (r) => fs.unlinkSync(path.join(r, 'prisma/migrations/001/migration.sql')),
  'file addition': (r) => fs.writeFileSync(path.join(r, 'prisma/migrations/new.sql'), 'SELECT 1;'),
  'file rename': (r) => fs.renameSync(path.join(r, 'prisma/migrations/001/migration.sql'), path.join(r, 'prisma/migrations/001/renamed.sql')),
  schema: (r) => fs.appendFileSync(path.join(r, 'prisma/schema.prisma'), '// edit'),
  compatibility: (r) => fs.writeFileSync(path.join(r, 'deploy/SCHEMA_COMPATIBILITY'), '2\n'),
  marker: (r) => fs.appendFileSync(path.join(r, 'deploy/REQUIRES_IRREVERSIBLE_MIGRATION'), 'edit'),
  'marker removal': (r) => fs.unlinkSync(path.join(r, 'deploy/REQUIRES_IRREVERSIBLE_MIGRATION')),
})) test(`digest changes for ${name}`, (t) => {
  const root = fixture(t), before = digest(root);
  assert.equal(before.status, 0, before.stderr);
  mutate(root);
  const after = digest(root);
  assert.equal(after.status, 0, after.stderr);
  assert.notEqual(after.stdout, before.stdout);
});

test('missing required paths and empty migrations fail closed', (t) => {
  for (const file of ['prisma/schema.prisma', 'deploy/SCHEMA_COMPATIBILITY', 'prisma/migrations']) {
    const root = fixture(t);
    fs.rmSync(path.join(root, file), { recursive: true });
    assert.notEqual(digest(root).status, 0, file);
  }
  const root = fixture(t);
  fs.rmSync(path.join(root, 'prisma/migrations'), { recursive: true });
  fs.mkdirSync(path.join(root, 'prisma/migrations'));
  assert.notEqual(digest(root).status, 0);
});

test('symlinked contract paths are rejected', (t) => {
  for (const file of ['prisma', 'prisma/migrations/001', 'prisma/schema.prisma', 'deploy/REQUIRES_IRREVERSIBLE_MIGRATION']) {
    const root = fixture(t);
    const result = run(`mv "${file}" "${file}.real"; ln -s "$(basename "${file}").real" "${file}"; test -L "${file}"`, root, { MSYS: 'winsymlinks:nativestrict' });
    if (result.status !== 0 && process.platform === 'win32') {
      t.skip('Windows account cannot create native symlinks'); return;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(digest(root).status, 0, file);
  }
});

test('approval helper requires an exact valid approved digest', (t) => {
  const root = fixture(t), approved = digest(root).stdout.trim();
  const check = (approval) => run(`. "${helper}"; migration_baseline_matches . "$APPROVAL"`, root, { APPROVAL: approval });
  assert.equal(check(approved).status, 0);
  for (const value of ['', 'bad', 'A'.repeat(64), '0'.repeat(64), approved + '\n']) {
    assert.notEqual(check(value).status, 0, value);
  }
});

function workflowGate(file, name, next) {
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows', file), 'utf8').replaceAll('\r\n', '\n');
  const block = workflow.slice(workflow.indexOf(`      - name: ${name}`), workflow.indexOf(`      - name: ${next}`));
  return block.slice(block.indexOf('        run: |\n') + 15).split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

test('actual workflow gates accept approved historical markers and refuse changed contracts', (t) => {
  const root = fixture(t);
  fs.copyFileSync(helper, path.join(root, 'deploy/migration-baseline.sh'));
  const approved = digest(root).stdout.trim();
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  // The release gate loads current tooling from main while hashing tag files.
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash\nif [ "$1" = show ]; then cat deploy/migration-baseline.sh; else echo test-sha; fi\n`);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env bash\necho success\n');
  fs.chmodSync(path.join(bin, 'git'), 0o755); fs.chmodSync(path.join(bin, 'gh'), 0o755);
  for (const [file, name, next] of [
    ['release.yml', 'Validate irreversible migration confirmations', 'Notify release start'],
    ['auto-release.yml', 'Check release preconditions', 'Compute next patch version'],
  ]) {
    const script = workflowGate(file, name, next);
    const gate = (approval, extra = {}) => run(`export PATH="$PWD/bin:$PATH"; ${script}`, root, {
      AUTO_RELEASE_MIGRATIONS_SHA256: approval, EVENT_NAME: 'workflow_dispatch',
      DOWNTIME: 'false', IRREVERSIBLE: 'false', DEPLOY_HOST: 'test', AUTO_RELEASE: 'on',
      SHA: 'test-sha', GH_TOKEN: 'test', GITHUB_REPOSITORY: 'test/repo',
      GITHUB_OUTPUT: path.join(root, 'output').replaceAll('\\', '/'), ...extra,
    });
    assert.equal(gate(approved).status, 0, file);
    for (const value of ['bad', '0'.repeat(64)]) assert.notEqual(gate(value).status, 0, `${file}: ${value}`);
    fs.appendFileSync(path.join(root, 'prisma/schema.prisma'), '// changed\n');
    assert.notEqual(gate(approved).status, 0, `${file}: changed schema`);
    fs.unlinkSync(path.join(root, 'deploy/REQUIRES_IRREVERSIBLE_MIGRATION'));
    assert.notEqual(gate(approved).status, 0, `${file}: removed marker`);
    assert.equal(gate('').status, 0, `${file}: legacy unmarked`);
    fs.writeFileSync(path.join(root, 'deploy/REQUIRES_IRREVERSIBLE_MIGRATION'), 'historical\n');
    if (file === 'release.yml') {
      assert.notEqual(gate('').status, 0);
      assert.equal(gate('', { DOWNTIME: 'true', IRREVERSIBLE: 'true' }).status, 0);
      assert.equal(gate('0'.repeat(64), { DOWNTIME: 'true', IRREVERSIBLE: 'true' }).status, 0);
      assert.notEqual(gate(approved, { DOWNTIME: 'false', IRREVERSIBLE: 'true' }).status, 0);
    } else {
      fs.writeFileSync(path.join(root, 'output'), '');
      assert.equal(gate('').status, 0);
      assert.match(fs.readFileSync(path.join(root, 'output'), 'utf8'), /skipped=true/);
    }
    fs.writeFileSync(path.join(root, 'prisma/schema.prisma'), 'model First {}\n');
  }
});

test('server approval is protected, fixed-path and checked before migration or traffic changes', (t) => {
  const root = fixture(t);
  fs.copyFileSync(helper, path.join(root, 'deploy/migration-baseline.sh'));
  fs.writeFileSync(path.join(root, 'deploy/RELEASE_RUNTIME_COMPATIBILITY'), '1\n');
  const approved = digest(root).stdout.trim();
  const approvalDir = path.join(root, 'etc/circle-release');
  fs.mkdirSync(approvalDir, { recursive: true });
  const approvalFile = path.join(approvalDir, 'migration-baseline.sha256');
  const server = fs.readFileSync(path.join(repo, 'deploy/release-deploy.sh'), 'utf8').replaceAll('\r\n', '\n');
  assert.doesNotMatch(server, /MIGRATION_BASELINE_PATH=.*\$\{/);
  // Execute the real preflight with a test-only literal path substitution.
  // The sentinel stands for all subsequent Docker/migration/traffic work.
  const preflight = server.slice(0, server.indexOf('exec 200>'))
    .replaceAll('/etc/circle-release', `${root.replaceAll('\\', '/')}/etc/circle-release`);
  fs.writeFileSync(path.join(root, 'deploy/server-test.sh'), `${preflight}\ntouch effects-started\n`);
  const launch = (extra = {}) => {
    fs.rmSync(path.join(root, 'effects-started'), { force: true });
    return run(`
      stat() {
        if [ "$1" = -c ] && [ "$2" = %u ]; then echo "$TEST_OWNER";
        elif [ "$1" = -c ] && [ "$2" = %a ]; then echo "$TEST_MODE";
        else command stat "$@"; fi
      }
      function [() {
        if [[ "$#" = 3 && "$1" = -w && "$2" = *migration-baseline.sha256 ]]; then
          [[ "$TEST_WRITABLE" = 1 ]]; return;
        fi
        builtin [ "$@"
      }
      export -f stat '['
      bash deploy/server-test.sh`, root, {
      RELEASE_LAUNCHER_ACTIVE: '1', RELEASE_TAG: 'v1.2.3',
      CIRCLE_BE_IMAGE: `ghcr.io/test/app@sha256:${'a'.repeat(64)}`,
      TEST_OWNER: '0', TEST_MODE: '644', TEST_WRITABLE: '0', ...extra,
    });
  };
  assert.notEqual(launch().status, 0, 'unapproved marker');
  fs.writeFileSync(approvalFile, approved + '\n');
  let result = launch();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(root, 'effects-started')), true);
  fs.writeFileSync(approvalFile, approved);
  result = launch();
  assert.equal(result.status, 0, '64-byte digest without a newline must remain valid');
  for (const extra of [{ TEST_OWNER: '1000' }, { TEST_MODE: '666' }, { TEST_WRITABLE: '1' }]) {
    assert.notEqual(launch(extra).status, 0, JSON.stringify(extra));
    assert.equal(fs.existsSync(path.join(root, 'effects-started')), false);
  }
  for (const approval of ['bad\n', approved + '\n\n', '0'.repeat(64) + '\n', approved + '\0']) {
    fs.writeFileSync(approvalFile, approval);
    assert.notEqual(launch().status, 0, JSON.stringify(approval));
    assert.equal(fs.existsSync(path.join(root, 'effects-started')), false);
  }
  fs.writeFileSync(approvalFile, approved + '\n');
  fs.appendFileSync(path.join(root, 'prisma/migrations/001/migration.sql'), '-- changed\n');
  assert.notEqual(launch().status, 0, 'edited migration must be refused before effects');
  assert.equal(fs.existsSync(path.join(root, 'effects-started')), false);
  fs.writeFileSync(path.join(root, 'prisma/migrations/001/migration.sql'), 'CREATE TABLE first(id INT);\n');
  const linkResult = run('mv etc/circle-release/migration-baseline.sha256 etc/circle-release/reviewed; ln -s reviewed etc/circle-release/migration-baseline.sha256; test -L etc/circle-release/migration-baseline.sha256', root, { MSYS: 'winsymlinks:nativestrict' });
  assert.equal(linkResult.status, 0, linkResult.stderr);
  assert.notEqual(launch().status, 0, 'symlinked server approval');
  assert.equal(fs.existsSync(path.join(root, 'effects-started')), false);
  fs.unlinkSync(approvalFile);
  fs.renameSync(path.join(approvalDir, 'reviewed'), approvalFile);
  fs.unlinkSync(path.join(root, 'deploy/REQUIRES_IRREVERSIBLE_MIGRATION'));
  assert.notEqual(launch().status, 0, 'removed marker must not bypass approval');
  assert.equal(fs.existsSync(path.join(root, 'effects-started')), false);
  assert.equal(launch({ RELEASE_DOWNTIME: '1', RELEASE_IRREVERSIBLE_MIGRATION: '1' }).status, 0);
  assert.notEqual(launch({ RELEASE_IRREVERSIBLE_MIGRATION: '1' }).status, 0);
  fs.rmSync(approvalFile);
  assert.equal(launch().status, 0, 'legacy unmarked deployment');
});
