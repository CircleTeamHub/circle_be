const fs = require('node:fs');
const path = require('node:path');
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
