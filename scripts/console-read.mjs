#!/usr/bin/env node
// Read-only automation client. Keep the key in environment, never command arguments or URLs.
const base = new URL(
  process.env.CIRCLE_CONSOLE_URL ?? 'http://127.0.0.1:3000/api/v1/',
);
if (
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  (base.protocol !== 'https:' &&
    !(
      base.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    ))
)
  throw Error(
    'Use HTTPS or loopback HTTP without credentials/query parameters',
  );
if (!base.pathname.endsWith('/')) base.pathname += '/';
const key = process.env.CIRCLE_CONSOLE_KEY;
if (!key || !/^cak_[A-Za-z0-9_-]{43}$/.test(key))
  throw Error('Set CIRCLE_CONSOLE_KEY to a valid scoped key');
const [command = 'tasks', argument] = process.argv.slice(2);
let path;
switch (command) {
  case 'tasks':
  case 'push':
  case 'analytics':
  case 'diagnostics':
    path = command;
    break;
  case 'timeline':
    if (!/^[a-f0-9-]{36}$/i.test(argument ?? ''))
      throw Error('timeline requires a user UUID');
    path = `users/${argument}/timeline`;
    break;
  default:
    throw Error(
      'Supported reads: tasks, push, analytics, diagnostics, timeline <user UUID>',
    );
}
const response = await fetch(new URL(`ops/read/${path}`, base), {
  headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok)
  throw Error(
    `Console read failed (HTTP ${response.status}); diagnostic ID: ${response.headers.get('x-request-id') ?? 'unavailable'}`,
  );
process.stdout.write(JSON.stringify(await response.json(), null, 2) + '\n');
