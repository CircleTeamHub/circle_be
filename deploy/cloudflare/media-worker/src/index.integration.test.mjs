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
let lastModified;
let warmEtag;
let warmLastModified;
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
  lastModified = cold.uploaded.toUTCString();
  const warm = await bucket.put('posts/fixture/warm.png', '0123456789', {
    httpMetadata: { contentType: 'image/png' },
  });
  warmEtag = warm.httpEtag;
  warmLastModified = warm.uploaded.toUTCString();
  await bucket.put('posts/fixture/empty.mp4', '');
  const primed = await runtime.dispatchFetch(
    'https://media.example.test/posts/fixture/warm.png',
  );
  assert.equal(await primed.text(), '0123456789');
  const cache = (await runtime.getCaches()).default;
  const cached = await cache.match(
    'https://media.example.test/posts/fixture/warm.png',
  );
  assert.ok(cached, 'image must be cached before warm-path tests');
  assert.equal(await cached.text(), '0123456789');
  await bucket.put('chat/fixture/secret.txt', 'private fixture');
});

for (const [name, headers, status] of [
  ['failed If-Match', () => ({ 'If-Match': '"different"' }), 412],
  [
    'failed If-Unmodified-Since',
    () => ({ 'If-Unmodified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' }),
    412,
  ],
  [
    'If-Match before If-None-Match',
    () => ({ 'If-Match': '"different"', 'If-None-Match': warmEtag }),
    412,
  ],
  [
    'If-Unmodified-Since before If-None-Match',
    () => ({
      'If-Unmodified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT',
      'If-None-Match': warmEtag,
    }),
    412,
  ],
  [
    'If-Match suppresses If-Unmodified-Since',
    () => ({
      'If-Match': warmEtag,
      'If-Unmodified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT',
    }),
    200,
  ],
]) {
  test(`warm image applies ${name}`, async () => {
    const response = await runtime.dispatchFetch(
      'https://media.example.test/posts/fixture/warm.png',
      { headers: headers() },
    );
    assert.equal(response.status, status);
    assert.equal(await response.text(), status === 200 ? '0123456789' : '');
  });
}

for (const [name, headers, status] of [
  ['failed If-Match', () => ({ 'If-Match': '"different"' }), 412],
  ['weak If-Match', () => ({ 'If-Match': `W/${coldEtag}` }), 412],
  [
    'failed If-Unmodified-Since',
    () => ({ 'If-Unmodified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' }),
    412,
  ],
  [
    'matching If-Unmodified-Since at HTTP seconds precision',
    () => ({ 'If-Unmodified-Since': lastModified }),
    200,
  ],
  [
    'matching If-Modified-Since at HTTP seconds precision',
    () => ({ 'If-Modified-Since': lastModified }),
    304,
  ],
  [
    'future If-Modified-Since',
    () => ({ 'If-Modified-Since': 'Thu, 01 Jan 2099 00:00:00 GMT' }),
    304,
  ],
  ['invalid date', () => ({ 'If-Modified-Since': 'invalid' }), 200],
  [
    'If-Match before If-None-Match',
    () => ({ 'If-Match': '"different"', 'If-None-Match': coldEtag }),
    412,
  ],
  [
    'If-Match suppresses If-Unmodified-Since',
    () => ({
      'If-Match': coldEtag,
      'If-Unmodified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT',
    }),
    200,
  ],
  [
    'If-None-Match suppresses If-Modified-Since',
    () => ({
      'If-None-Match': '"different"',
      'If-Modified-Since': 'Thu, 01 Jan 2099 00:00:00 GMT',
    }),
    200,
  ],
]) {
  test(`HEAD applies ${name}`, async () => {
    const response = await runtime.dispatchFetch(
      'https://media.example.test/posts/fixture/cold.mp4',
      { method: 'HEAD', headers: headers() },
    );
    assert.equal(response.status, status);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.has('Content-Length'), status === 200);
  });
}

for (const path of ['cold.mp4', 'warm.png']) {
  for (const [name, validator, status] of [
    ['matching ETag', () => (path === 'warm.png' ? warmEtag : coldEtag), 206],
    ['mismatched ETag', () => '"different"', 200],
    ['weak ETag', () => `W/${coldEtag}`, 200],
    [
      'matching date',
      () => (path === 'warm.png' ? warmLastModified : lastModified),
      206,
    ],
    ['older date', () => 'Thu, 01 Jan 1970 00:00:00 GMT', 200],
    ['future date', () => 'Thu, 01 Jan 2099 00:00:00 GMT', 200],
  ]) {
    test(`${path} honors If-Range ${name}`, async () => {
      const response = await runtime.dispatchFetch(
        `https://media.example.test/posts/fixture/${path}`,
        {
          headers: { Range: 'bytes=2-4', 'If-Range': validator() },
        },
      );
      assert.equal(response.status, status);
      assert.equal(
        response.headers.get('Content-Length'),
        status === 206 ? '3' : '10',
      );
      assert.equal(
        response.headers.get('Content-Range'),
        status === 206 ? 'bytes 2-4/10' : null,
      );
      assert.equal(
        await response.text(),
        status === 206 ? '234' : '0123456789',
      );
    });
  }
  for (const [range, status] of [
    ['bytes=99-100', 416],
    ['bytes=-0', 416],
    ['bytes=4-2', 200],
    ['items=2-4', 200],
    ['bytes=0-1,4-5', 200],
    ['bytes=invalid', 200],
  ]) {
    test(`${path} handles unsatisfiable or ignored ${range}`, async () => {
      const response = await runtime.dispatchFetch(
        `https://media.example.test/posts/fixture/${path}`,
        { headers: { Range: range } },
      );
      assert.equal(response.status, status);
      assert.equal(
        response.headers.get('Content-Range'),
        status === 416 ? 'bytes */10' : null,
      );
      assert.equal(await response.text(), status === 416 ? '' : '0123456789');
    });
  }
  test(`${path} applies read preconditions before an unsatisfiable range`, async () => {
    const response = await runtime.dispatchFetch(
      `https://media.example.test/posts/fixture/${path}`,
      {
        headers: {
          Range: 'bytes=99-100',
          'If-None-Match': path === 'warm.png' ? warmEtag : coldEtag,
        },
      },
    );
    assert.equal(response.status, 304);
    assert.equal(response.headers.get('Content-Range'), null);
    assert.equal(await response.text(), '');
  });
  test(`${path} ignores an unsatisfiable range when If-Range mismatches`, async () => {
    const response = await runtime.dispatchFetch(
      `https://media.example.test/posts/fixture/${path}`,
      {
        headers: { Range: 'bytes=99-100', 'If-Range': '"different"' },
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Range'), null);
    assert.equal(await response.text(), '0123456789');
  });
}

test('empty object rejects a byte range with 416', async () => {
  const response = await runtime.dispatchFetch(
    'https://media.example.test/posts/fixture/empty.mp4',
    { headers: { Range: 'bytes=0-' } },
  );
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('Content-Range'), 'bytes */0');
  assert.equal(await response.text(), '');
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
