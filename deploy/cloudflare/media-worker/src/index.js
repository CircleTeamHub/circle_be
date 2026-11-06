/** @type {ExportedHandler<Env>} */
const worker = {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, {
        status: 405,
        headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
      });
    }
    const url = new URL(request.url);
    let key;
    try {
      key = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return new Response(null, {
        status: 400,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (
      !['avatars', 'covers', 'posts', 'friends', 'uploads'].some((prefix) =>
        key.startsWith(`${prefix}/`),
      ) ||
      key.split('/').some((part) => part === '.' || part === '..')
    ) {
      return new Response(null, {
        status: 403,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    try {
      const limit = await env.MEDIA_RATE_LIMITER.limit({
        key: request.headers.get('CF-Connecting-IP') ?? 'unknown',
      });
      if (!limit.success) {
        return new Response(null, {
          status: 429,
          headers: { 'Retry-After': '10', 'Cache-Control': 'no-store' },
        });
      }
      url.search = '';
      url.hash = '';
      url.pathname = `/${key.split('/').map(encodeURIComponent).join('/')}`;
      // Ignore unsupported/malformed ranges rather than trusting R2's normalized
      // full-object range metadata to mean that a partial read was satisfied.
      const readHeaders = new Headers(request.headers);
      const rangeParts = /^bytes=(\d*)-(\d*)$/i.exec(
        readHeaders.get('Range') ?? '',
      );
      const range =
        rangeParts &&
        (rangeParts[1] || rangeParts[2]) &&
        !(
          rangeParts[1] &&
          rangeParts[2] &&
          Number(rangeParts[1]) > Number(rangeParts[2])
        )
          ? rangeParts
          : null;
      if (!range || request.method === 'HEAD') readHeaders.delete('Range');
      // Cache API handles read validators, but not write-style preconditions.
      if (
        request.method === 'GET' &&
        !readHeaders.has('If-Match') &&
        !readHeaders.has('If-Unmodified-Since')
      ) {
        const cacheHeaders = new Headers(readHeaders);
        cacheHeaders.delete('Range');
        const cached = await caches.default.match(
          new Request(url, { headers: cacheHeaders }),
        );
        if (cached) {
          if (!range || cached.status !== 200) return cached;
          const selected = selectRange(
            range,
            readHeaders.get('If-Range'),
            cached.headers.get('ETag'),
            cached.headers.get('Last-Modified'),
            Number(cached.headers.get('Content-Length')),
          );
          if (selected === undefined) return cached;
          await cached.body?.cancel();
          if (selected === null) {
            const headers = new Headers(cached.headers);
            headers.set(
              'Content-Range',
              `bytes */${cached.headers.get('Content-Length')}`,
            );
            headers.delete('Content-Length');
            return new Response(null, { status: 416, headers });
          }
          cacheHeaders.set(
            'Range',
            `bytes=${selected.offset}-${selected.offset + selected.length - 1}`,
          );
          const partial = await caches.default.match(
            new Request(url, { headers: cacheHeaders }),
          );
          if (partial) return partial;
        }
      }
      let object =
        request.method === 'HEAD' || range
          ? await env.MEDIA.head(key)
          : await env.MEDIA.get(key, {
              onlyIf: readHeaders,
            });
      if (!object) {
        return new Response(null, {
          status: 404,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('ETag', object.httpEtag);
      headers.set('Last-Modified', object.uploaded.toUTCString());
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set(
        'Access-Control-Expose-Headers',
        'ETag, Content-Length, Content-Range',
      );
      headers.set('X-Content-Type-Options', 'nosniff');
      if (!headers.has('Cache-Control'))
        headers.set('Cache-Control', 'public, max-age=3600');

      const conditionStatus = preconditionStatus(readHeaders, object);
      if (conditionStatus) {
        if ('body' in object)
          await /** @type {R2ObjectBody} */ (object).body.cancel();
        headers.delete('Content-Length');
        return new Response(null, { status: conditionStatus, headers });
      }
      if (request.method === 'HEAD') {
        headers.set('Content-Length', String(object.size));
        return new Response(null, { headers });
      }

      let status = 200;
      if (range) {
        const selected = selectRange(
          range,
          readHeaders.get('If-Range'),
          object.httpEtag,
          object.uploaded.toUTCString(),
          object.size,
        );
        if (selected === null) {
          headers.set('Content-Range', `bytes */${object.size}`);
          headers.delete('Content-Length');
          return new Response(null, { status: 416, headers });
        }
        object = await env.MEDIA.get(key, {
          range: selected,
          onlyIf: readHeaders,
        });
        if (!object)
          return new Response(null, {
            status: 404,
            headers: { 'Cache-Control': 'no-store' },
          });
        const statusAfterRead = preconditionStatus(readHeaders, object);
        if (statusAfterRead) {
          if ('body' in object)
            await /** @type {R2ObjectBody} */ (object).body.cancel();
          return new Response(null, { status: statusAfterRead, headers });
        }
        if (selected) {
          headers.set(
            'Content-Range',
            `bytes ${selected.offset}-${selected.offset + selected.length - 1}/${object.size}`,
          );
          headers.set('Content-Length', String(selected.length));
          status = 206;
        }
      }
      if (status === 200) headers.set('Content-Length', String(object.size));
      // R2 results that contain a body are R2ObjectBody instances by API contract.
      const response = new Response(/** @type {R2ObjectBody} */ (object).body, {
        status,
        headers,
      });
      if (
        status === 200 &&
        !request.headers.has('Range') &&
        object.size <= 8 * 1024 * 1024 &&
        headers.get('Content-Type')?.toLowerCase().startsWith('image/') &&
        !/\b(private|no-store|no-cache)\b/i.test(
          headers.get('Cache-Control') ?? '',
        )
      ) {
        ctx.waitUntil(
          caches.default.put(new Request(url), response.clone()).catch(() => {
            console.warn(JSON.stringify({ event: 'media_cache_write_failed' }));
          }),
        );
      }
      return response;
    } catch {
      console.error(JSON.stringify({ event: 'media_read_failed' }));
      return new Response(null, {
        status: 503,
        headers: { 'Retry-After': '10', 'Cache-Control': 'no-store' },
      });
    }
  },
};

export default worker;

/** @param {Headers} headers @param {R2Object} object */
function preconditionStatus(headers, object) {
  const ifMatch = headers.get('If-Match');
  const unmodifiedSince = headers.get('If-Unmodified-Since');
  const uploadedSeconds = Math.floor(object.uploaded.getTime() / 1000);
  if (ifMatch !== null) {
    if (
      !ifMatch
        .split(',')
        .some(
          (value) => value.trim() === '*' || value.trim() === object.httpEtag,
        )
    )
      return 412;
  } else if (
    unmodifiedSince &&
    uploadedSeconds > Math.floor(Date.parse(unmodifiedSince) / 1000)
  ) {
    return 412;
  }
  const ifNoneMatch = headers.get('If-None-Match');
  if (ifNoneMatch !== null) {
    if (
      ifNoneMatch
        .split(',')
        .some(
          (value) =>
            value.trim() === '*' ||
            value.trim().replace(/^W\//, '') === object.httpEtag,
        )
    )
      return 304;
  } else {
    const modifiedSince = headers.get('If-Modified-Since');
    if (
      modifiedSince &&
      uploadedSeconds <= Math.floor(Date.parse(modifiedSince) / 1000)
    )
      return 304;
  }
  return undefined;
}

/**
 * Undefined ignores Range; null means a valid but unsatisfiable byte range.
 * @param {RegExpExecArray} parts
 * @param {string | null} ifRange
 * @param {string | null} etag
 * @param {string | null} lastModified
 * @param {number} size
 */
function selectRange(parts, ifRange, etag, lastModified, size) {
  if (
    ifRange !== null &&
    ifRange !== etag &&
    (ifRange.startsWith('"') ||
      ifRange.startsWith('W/') ||
      Date.parse(ifRange) !== Date.parse(lastModified ?? ''))
  )
    return undefined;
  const offset = parts[1]
    ? Number(parts[1])
    : Math.max(0, size - Number(parts[2]));
  const end = parts[1]
    ? parts[2]
      ? Math.min(Number(parts[2]), size - 1)
      : size - 1
    : size - 1;
  if (offset >= size || end < offset) return null;
  return { offset, length: end - offset + 1 };
}
