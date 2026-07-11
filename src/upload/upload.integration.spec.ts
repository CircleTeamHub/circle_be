import { UploadService } from './upload.service';

const endpoint = process.env.MINIO_TEST_URL;
const describeMinio = endpoint ? describe : describe.skip;

describeMinio('UploadService real MinIO integration', () => {
  let service: UploadService;

  beforeAll(async () => {
    service = new UploadService({
      get: (key: string) =>
        ({
          MINIO_ENDPOINT: endpoint,
          MINIO_PUBLIC_URL: endpoint,
          MINIO_ACCESS_KEY: process.env.MINIO_TEST_ACCESS_KEY,
          MINIO_SECRET_KEY: process.env.MINIO_TEST_SECRET_KEY,
          MINIO_BUCKET: process.env.MINIO_TEST_BUCKET,
        })[key] ?? null,
    } as any);
    (service as any).ready = true;
  });

  it('signs MIME and size and permits only the first write to a key', async () => {
    const body = Buffer.from('real-minio-payload');
    const grant = await service.presign(
      'asset.png',
      'image/png',
      body.length,
      'posts',
      'integration-user',
    );
    expect(grant.uploadUrl).not.toContain('x-amz-checksum-crc32');

    const first = await fetch(grant.uploadUrl, {
      method: 'PUT',
      headers: grant.requiredHeaders,
      body,
    });
    expect(first.status).toBe(200);

    const repeated = await fetch(grant.uploadUrl, {
      method: 'PUT',
      headers: grant.requiredHeaders,
      body,
    });
    expect(repeated.status).toBe(412);

    const tamperGrant = await service.presign(
      'tamper.png',
      'image/png',
      body.length,
      'posts',
      'integration-user',
    );
    const tampered = await fetch(tamperGrant.uploadUrl, {
      method: 'PUT',
      headers: {
        ...tamperGrant.requiredHeaders,
        'Content-Type': 'text/html',
      },
      body,
    });
    expect(tampered.status).toBe(403);
  });
});
