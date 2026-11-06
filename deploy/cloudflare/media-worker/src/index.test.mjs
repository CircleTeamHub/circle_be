import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './index.js';

function fixture({ object, cacheHit, limited = false } = {}) {
  const calls = [];
  const writes = [];
  const tasks = [];
  const value = object ?? {
    size: 5,
    httpEtag: '"fixture-etag"',
    uploaded: new Date('2026-11-05T12:00:00Z'),
    httpMetadata: {},
    writeHttpMetadata(headers) {
      headers.set('Content-Type', 'image/png');
    },
    body: new Response('image').body,
  };
  globalThis.caches = {
    default: {
      async match() {
        calls.push('cache');
        return cacheHit?.clone();
      },
      async put(key, response) {
        writes.push({ key, response });
      },
    },
  };
  const env = {
    MEDIA: {
      async get(key, options) {
        calls.push({ get: key, options });
        return value;
      },
      async head(key) {
        calls.push({ head: key });
        return value;
      },
    },
    MEDIA_RATE_LIMITER: {
      async limit() {
        calls.push('rate');
        return { success: !limited };
      },
    },
  };
  const ctx = {
    waitUntil(promise) {
      tasks.push(promise);
    },
  };
  const request = (path, init) =>
    new Request(`https://media.example.com/${path}`, init);
  return { env, ctx, calls, writes, tasks, request };
}

for (const path of [
  'chat/u/a.jpg',
  'notes/u/a.jpg',
  'note-exports/u/a.zip',
  'stickers/u/a.png',
  'unknown/a.jpg',
  '%2fchat/u/a.jpg',
  'avatars%2f..%2fchat/u/a.jpg',
  'avatars/../notes/u/a.jpg',
  'avatars',
]) {
  test(`denies ${path} before cache or bucket access`, async () => {
    const f = fixture({ cacheHit: new Response('cached private data') });
    const response = await worker.fetch(f.request(path), f.env, f.ctx);
    assert.equal(response.status, 403);
    assert.deepEqual(f.calls, []);
  });
}

for (const prefix of ['avatars', 'covers', 'posts', 'friends', 'uploads']) {
  test(`streams public ${prefix} objects and caches the response`, async () => {
    const f = fixture();
    const response = await worker.fetch(
      f.request(`${prefix}/u/a.png`),
      f.env,
      f.ctx,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'image');
    assert.equal(response.headers.get('ETag'), '"fixture-etag"');
    assert.equal(response.headers.get('Content-Length'), '5');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    await Promise.all(f.tasks);
    assert.equal(f.writes.length, 1);
  });
}

test('rejects writes without touching rate limiter, cache or bucket', async () => {
  const f = fixture();
  const response = await worker.fetch(
    f.request('avatars/u/a.png', { method: 'PUT', body: 'new' }),
    f.env,
    f.ctx,
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  assert.deepEqual(f.calls, []);
});

test('HEAD returns metadata without downloading an object body', async () => {
  const f = fixture();
  const response = await worker.fetch(
    f.request('avatars/u/a.png', { method: 'HEAD' }),
    f.env,
    f.ctx,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('Content-Length'), '5');
  assert.equal(f.calls.filter((value) => value?.get).length, 0);
  assert.equal(f.calls.filter((value) => value?.head).length, 1);
});

test('returns 429 when a public read is rate limited', async () => {
  const f = fixture({ limited: true });
  const response = await worker.fetch(
    f.request('avatars/u/a.png'),
    f.env,
    f.ctx,
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '10');
  assert.deepEqual(f.calls, ['rate']);
});

test('serves cached public data without a bucket read', async () => {
  const f = fixture({ cacheHit: new Response('cached public image') });
  const response = await worker.fetch(
    f.request('avatars/u/a.png'),
    f.env,
    f.ctx,
  );
  assert.equal(await response.text(), 'cached public image');
  assert.equal(f.calls.filter((value) => value?.get).length, 0);
});

test('returns a video byte range with correct headers and no partial-response cache write', async () => {
  const f = fixture();
  f.env.MEDIA.get = async (key, options) => {
    assert.deepEqual(options.range, { offset: 2, length: 3 });
    return {
      size: 10,
      httpEtag: '"video"',
      uploaded: new Date(),
      httpMetadata: {},
      range: { offset: 2, length: 3, suffix: undefined },
      writeHttpMetadata(headers) {
        headers.set('Content-Type', 'video/mp4');
      },
      body: new Response('234').body,
    };
  };
  const response = await worker.fetch(
    f.request('posts/u/a.mp4', { headers: { Range: 'bytes=2-4' } }),
    f.env,
    f.ctx,
  );
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 2-4/10');
  assert.equal(response.headers.get('Content-Length'), '3');
  assert.equal(await response.text(), '234');
  await Promise.all(f.tasks);
  assert.equal(f.writes.length, 0);
});

test('returns 304 when the bucket rejects If-None-Match', async () => {
  const f = fixture();
  f.env.MEDIA.get = async () => ({
    size: 5,
    httpEtag: '"same"',
    uploaded: new Date(),
    httpMetadata: {},
    writeHttpMetadata() {},
  });
  const response = await worker.fetch(
    f.request('avatars/u/a.png', { headers: { 'If-None-Match': '"same"' } }),
    f.env,
    f.ctx,
  );
  assert.equal(response.status, 304);
  assert.equal(response.headers.has('Content-Length'), false);
});

test('returns 404 for missing objects without caching the error', async () => {
  const f = fixture();
  f.env.MEDIA.get = async () => null;
  const response = await worker.fetch(
    f.request('avatars/u/missing.png'),
    f.env,
    f.ctx,
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(f.writes.length, 0);
});

test('rejects malformed percent encoding without accessing storage', async () => {
  const f = fixture();
  const response = await worker.fetch(
    f.request('avatars/%ZZ.png'),
    f.env,
    f.ctx,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(f.calls, []);
});

test('does not edge-cache objects with private cache metadata', async () => {
  const f = fixture();
  f.env.MEDIA.get = async () => ({
    size: 5,
    httpEtag: '"private-cache"',
    uploaded: new Date(),
    httpMetadata: { cacheControl: 'private, max-age=60' },
    writeHttpMetadata(headers) {
      headers.set('Cache-Control', 'private, max-age=60');
    },
    body: new Response('image').body,
  });
  const response = await worker.fetch(
    f.request('avatars/u/a.png'),
    f.env,
    f.ctx,
  );
  assert.equal(response.headers.get('Cache-Control'), 'private, max-age=60');
  await Promise.all(f.tasks);
  assert.equal(f.writes.length, 0);
});

test('returns 412 for failed If-Match preconditions', async () => {
  const f = fixture();
  f.env.MEDIA.get = async () => ({
    size: 5,
    httpEtag: '"current"',
    uploaded: new Date(),
    httpMetadata: {},
    writeHttpMetadata() {},
  });
  const response = await worker.fetch(
    f.request('avatars/u/a.png', { headers: { 'If-Match': '"old"' } }),
    f.env,
    f.ctx,
  );
  assert.equal(response.status, 412);
  assert.equal(response.headers.has('Content-Length'), false);
});

test('HEAD honors a matching If-None-Match without a body read', async () => {
  const f = fixture();
  const response = await worker.fetch(
    f.request('avatars/u/a.png', {
      method: 'HEAD',
      headers: { 'If-None-Match': '"fixture-etag"' },
    }),
    f.env,
    f.ctx,
  );
  assert.equal(response.status, 304);
  assert.equal(response.headers.has('Content-Length'), false);
  assert.equal(f.calls.filter((value) => value?.get).length, 0);
});

test('does not log object URLs or provider errors on read failure', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (value) => logged.push(value));
  const f = fixture();
  f.env.MEDIA.get = async () => {
    throw new Error('secret provider URL and token');
  };
  const response = await worker.fetch(
    f.request('avatars/u/private-identifier.png'),
    f.env,
    f.ctx,
  );
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '');
  assert.equal(logged.length, 1);
  assert.equal(
    logged.some((value) => /secret|private-identifier|token/.test(value)),
    false,
  );
});

test('decodes an object key once and removes query strings from cache keys', async () => {
  const f = fixture();
  const response = await worker.fetch(
    f.request('avatars/u/a%20b.png?cache-buster=1'),
    f.env,
    f.ctx,
  );
  assert.equal(response.status, 200);
  assert.equal(f.calls.find((value) => value?.get)?.get, 'avatars/u/a b.png');
  await Promise.all(f.tasks);
  assert.equal(new URL(f.writes[0].key.url).search, '');
});

test('full reads stay 200 when R2 includes normalized range metadata', async () => {
  const f = fixture();
  f.env.MEDIA.get = async () => ({
    size: 5,
    httpEtag: '"whole"',
    uploaded: new Date(),
    httpMetadata: {},
    range: { offset: 0, length: 5, suffix: undefined },
    writeHttpMetadata() {},
    body: new Response('image').body,
  });
  const response = await worker.fetch(
    f.request('avatars/u/a.png'),
    f.env,
    f.ctx,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('Content-Range'), false);
  assert.equal(await response.text(), 'image');
});

for (const [contentType, size] of [
  ['video/mp4', 5],
  ['image/png', 9 * 1024 * 1024],
]) {
  test(`streams ${contentType}/${size} without cloning a large or video body for edge cache`, async () => {
    const f = fixture();
    f.env.MEDIA.get = async () => ({
      size,
      httpEtag: '"stream-only"',
      uploaded: new Date(),
      httpMetadata: { contentType },
      writeHttpMetadata(headers) {
        headers.set('Content-Type', contentType);
      },
      body: new Response(new Uint8Array(size)).body,
    });
    const response = await worker.fetch(
      f.request('posts/u/asset'),
      f.env,
      f.ctx,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, size);
    await Promise.all(f.tasks);
    assert.equal(f.writes.length, 0);
  });
}
