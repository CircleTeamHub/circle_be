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
      if (request.method === 'GET') {
        const cached = await caches.default.match(
          new Request(url, { headers: request.headers }),
        );
        if (cached) return cached;
      }
      const object =
        request.method === 'HEAD'
          ? await env.MEDIA.head(key)
          : await env.MEDIA.get(key, {
              range: request.headers,
              onlyIf: request.headers,
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

      if (request.method === 'HEAD') {
        const candidates = request.headers
          .get('If-None-Match')
          ?.split(',')
          .map((value) => value.trim());
        if (
          candidates?.some(
            (value) =>
              value === '*' ||
              value === object.httpEtag ||
              value === `W/${object.httpEtag}`,
          )
        ) {
          return new Response(null, { status: 304, headers });
        }
        headers.set('Content-Length', String(object.size));
        return new Response(null, { headers });
      }
      if (!('body' in object)) {
        const ifMatch = request.headers.get('If-Match');
        const unmodifiedSince = request.headers.get('If-Unmodified-Since');
        const failedMatch =
          ifMatch &&
          ifMatch !== '*' &&
          !ifMatch
            .split(',')
            .map((value) => value.trim())
            .includes(object.httpEtag);
        const failedDate =
          !ifMatch &&
          unmodifiedSince &&
          Math.floor(object.uploaded.getTime() / 1000) >
            Math.floor(Date.parse(unmodifiedSince) / 1000);
        headers.delete('Content-Length');
        return new Response(null, {
          status: failedMatch || failedDate ? 412 : 304,
          headers,
        });
      }

      let status = 200;
      if (request.headers.has('Range') && object.range) {
        const range = object.range;
        const suffix = 'suffix' in range ? range.suffix : undefined;
        const offset =
          ('offset' in range ? range.offset : undefined) ??
          Math.max(0, object.size - (suffix ?? object.size));
        const length =
          ('length' in range ? range.length : undefined) ??
          Math.min(object.size - offset, suffix ?? object.size);
        headers.set(
          'Content-Range',
          `bytes ${offset}-${offset + length - 1}/${object.size}`,
        );
        headers.set('Content-Length', String(length));
        status = 206;
      } else {
        headers.set('Content-Length', String(object.size));
      }
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
