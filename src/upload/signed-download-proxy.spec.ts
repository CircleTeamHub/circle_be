import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadService } from './upload.service';

describe('signed download proxy', () => {
  const endpoint = 'https://account.r2.cloudflarestorage.com';
  const proxyBase = 'https://api.example.com/r2-media';
  const bucket = 'test-media';
  const now = new Date('2026-11-06T10:27:31.000Z');
  const signingDate = new Date('2026-11-06T10:00:00.000Z');
  const credentials = {
    accessKeyId: 'synthetic-access-key',
    secretAccessKey: 'synthetic-secret-key',
  };
  const client = new S3Client({
    endpoint,
    region: 'auto',
    credentials,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

  function service(proxy?: string, delivery?: string) {
    return new UploadService(
      new ConfigService({
        MINIO_ENDPOINT: endpoint,
        MINIO_PUBLIC_URL: endpoint,
        MINIO_ACCESS_KEY: credentials.accessKeyId,
        MINIO_SECRET_KEY: credentials.secretAccessKey,
        MINIO_BUCKET: bucket,
        OBJECT_STORAGE_REGION: 'auto',
        OBJECT_STORAGE_FORCE_PATH_STYLE: true,
        OBJECT_STORAGE_SIGNED_DOWNLOAD_PROXY_BASE: proxy,
        OBJECT_STORAGE_DELIVERY_URL: delivery,
      }),
    );
  }

  beforeEach(() => {
    jest.useFakeTimers({
      now: now.getTime(),
      doNotFake: ['nextTick', 'setImmediate'],
    });
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() => client.destroy());

  it('prefixes the original encoded path and raw signature query without changing signing date or TTL', async () => {
    const key = 'chat/synthetic-user/space +%雪?#.png';
    const direct = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 7200, signingDate },
    );
    const upload = service(proxyBase);
    const result = await upload.createPresignedGetUrl(key, 7200, signingDate);

    expect(result.url).toBe(`${proxyBase}${direct.slice(endpoint.length)}`);
    expect(result.url.split('?')[1]).toBe(direct.split('?')[1]);
    expect(new URL(result.url).searchParams.get('X-Amz-Date')).toBe(
      '20261106T100000Z',
    );
    expect(new URL(result.url).searchParams.get('X-Amz-Expires')).toBe('7200');
    expect(result.expiresAt).toEqual(new Date(now.getTime() + 7200 * 1000));
    expect(upload.objectKeyFromPublicUrl(result.url)).toBe(key);
  });

  it('leaves the default direct GET byte-identical', async () => {
    const key = 'chat/synthetic-user/image.png';
    const direct = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 300 },
    );
    expect((await service().createPresignedGetUrl(key)).url).toBe(direct);
  });

  it('keeps PUT signatures, required headers and private file URL behavior unchanged when enabled', async () => {
    const upload = service(proxyBase);
    Object.assign(upload, { ready: true });
    const result = await upload.presign(
      'image.png',
      'image/png',
      123,
      'chat',
      'synthetic-user',
    );
    const direct = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: result.key,
        ContentType: 'image/png',
        ContentLength: 123,
        IfNoneMatch: '*',
      }),
      { expiresIn: 300, signableHeaders: new Set(['content-type']) },
    );
    expect(result.uploadUrl).toBe(direct);
    expect(result.requiredHeaders).toEqual({
      'Content-Type': 'image/png',
      'Content-Length': '123',
      'If-None-Match': '*',
    });
    expect(result.fileUrl).toBeNull();
  });

  it('recognizes its own signed private bucket/key URL without accepting other buckets or hosts', async () => {
    const upload = service(proxyBase);
    const key = 'notes/synthetic-user/image.png';
    const { url } = await upload.createPresignedGetUrl(key, 300, signingDate);
    expect(upload.objectKeyFromPublicUrl(url)).toBe(key);
    expect(
      upload.objectKeyFromPublicUrl(
        `${proxyBase}/${bucket}/${key}?signature=synthetic`,
      ),
    ).toBe(key);
    expect(
      upload.objectKeyFromPublicUrl(`${proxyBase}/other-bucket/${key}`),
    ).toBeNull();
    expect(
      upload.objectKeyFromPublicUrl(
        `https://attacker.example/r2-media/${bucket}/${key}`,
      ),
    ).toBeNull();
    expect(
      upload.objectKeyFromPublicUrl(`${proxyBase}-other/${bucket}/${key}`),
    ).toBeNull();
  });

  it.each([
    'notes/%ZZ',
    'notes/user/%2e%2e/other.png',
    'notes/user/./image.png',
  ])(
    'rejects malformed escapes and dot segments at the proxy URL boundary (%#)',
    (path) => {
      expect(
        service(proxyBase).objectKeyFromPublicUrl(
          `${proxyBase}/${bucket}/${path}`,
        ),
      ).toBeNull();
    },
  );

  it('preserves legacy key extraction when the public delivery base shares the proxy origin', () => {
    const upload = service(
      'https://api.example.com',
      'https://api.example.com/public',
    );
    expect(
      upload.objectKeyFromPublicUrl(
        'https://api.example.com/public/notes/user/space%20image.png',
      ),
    ).toBe('notes/user/space%20image.png');
  });

  it('recognizes the proxy bucket before a broader canonical delivery base', async () => {
    const upload = service(proxyBase, 'https://api.example.com');
    const key = 'notes/synthetic-user/image.png';
    const { url } = await upload.createPresignedGetUrl(key, 300, signingDate);
    expect(upload.objectKeyFromPublicUrl(url)).toBe(key);
  });
});
