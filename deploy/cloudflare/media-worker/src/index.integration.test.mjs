import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { parse } from 'jsonc-parser';

const configErrors = [];
const config = parse(
  readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
  configErrors,
  { allowTrailingComma: true },
);
assert.deepEqual(configErrors, []);
let runtime;
let etag;
let coldEtag;
before(async () => {
  runtime = new Miniflare({
    host: '127.0.0.1',
    port: 0,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    logRequests: false,
    workers: [
      {
        config: {
          name: config.name,
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents: readFileSync(
                  new URL('./index.js', import.meta.url),
                  'utf8',
                ),
              },
            },
          },
          env: {
            MEDIA: {
              type: 'r2',
              name: 'local-media-fixture',
              dev: { remote: false },
            },
            MEDIA_RATE_LIMITER: {
              type: 'rate-limit',
              namespace: config.ratelimits[0].namespace_id,
              simple: config.ratelimits[0].simple,
            },
          },
        },
      },
    ],
  });
  const bucket = await runtime.getR2Bucket('MEDIA');
  const object = await bucket.put('posts/fixture/video.mp4', '0123456789', {
    httpMetadata: {
      contentType: 'video/mp4',
      cacheControl: 'public, max-age=3600',
    },
  });
  etag = object.httpEtag;
  const cold = await bucket.put('posts/fixture/cold.mp4', '0123456789', {
    httpMetadata: { contentType: 'video/mp4' },
  });
  coldEtag = cold.httpEtag;
  await bucket.put('chat/fixture/secret.txt', 'private fixture');
});
after(async () => {
  await runtime?.dispose();
});

test('local Worker runtime streams a public R2 object with metadata', async () => {
  const response = await runtime.dispatchFetch(
    'https://media.example.test/posts/fixture/video.mp4',
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'video/mp4');
  assert.equal(response.headers.get('Content-Length'), '10');
  assert.equal(response.headers.get('ETag'), etag);
  assert.equal(await response.text(), '0123456789');
});

test('local Worker runtime handles HEAD without a response body', async () => {
  const response = await runtime.dispatchFetch(
    'https://media.example.test/posts/fixture/video.mp4',
    { method: 'HEAD' },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Length'), '10');
  assert.equal(await response.text(), '');
});

for (const [range, body, contentRange] of [
  ['bytes=2-4', '234', 'bytes 2-4/10'],
  ['bytes=-3', '789', 'bytes 7-9/10'],
]) {
  test(`local Worker runtime serves ${range}`, async () => {
    const response = await runtime.dispatchFetch(
      'https://media.example.test/posts/fixture/cold.mp4',
      { headers: { Range: range } },
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), contentRange);
    assert.equal(await response.text(), body);
  });
}

test('local Worker runtime revalidates ETags', async () => {
  const response = await runtime.dispatchFetch(
    'https://media.example.test/posts/fixture/video.mp4',
    { headers: { 'If-None-Match': etag } },
  );
  assert.equal(response.status, 304);
  assert.equal(await response.text(), '');
});

test('local Worker runtime returns 304 for an uncached conditional R2 read', async () => {
  const response = await runtime.dispatchFetch(
    'https://media.example.test/posts/fixture/cold.mp4',
    { headers: { 'If-None-Match': coldEtag } },
  );
  assert.equal(response.status, 304);
  assert.equal(await response.text(), '');
});

test('local Worker runtime returns 412 for an uncached failed If-Match', async () => {
  const response = await runtime.dispatchFetch(
    'https://media.example.test/posts/fixture/cold.mp4',
    { headers: { 'If-Match': '"different"' } },
  );
  assert.equal(response.status, 412);
  assert.equal(await response.text(), '');
});

for (const path of [
  'chat/fixture/secret.txt',
  'notes/fixture/a.png',
  'posts%2f..%2fchat/fixture/secret.txt',
]) {
  test(`local Worker runtime cannot expose ${path}`, async () => {
    const response = await runtime.dispatchFetch(
      `https://media.example.test/${path}`,
    );
    assert.equal(response.status, 403);
    assert.equal(await response.text(), '');
  });
}
