import { UploadService, buildPublicReadBucketPolicy } from './upload.service';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

describe('UploadService', () => {
  const privateMinioHost = ['10', '0', '0', '195'].join('.');
  const privateMinioUrl = `http://${privateMinioHost}:9000`;

  it('builds a bucket policy that allows public reads for uploaded objects', () => {
    const policy = JSON.parse(buildPublicReadBucketPolicy('circle'));

    expect(policy).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'PublicReadGetObject',
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [
            'arn:aws:s3:::circle/avatars/*',
            'arn:aws:s3:::circle/covers/*',
            'arn:aws:s3:::circle/posts/*',
            'arn:aws:s3:::circle/notes/*',
            'arn:aws:s3:::circle/chat/*',
            'arn:aws:s3:::circle/uploads/*',
          ],
        },
      ],
    });
    expect(JSON.stringify(policy)).not.toContain('note-exports');
  });

  it('applies a public-read bucket policy during module init', async () => {
    const send = jest.fn().mockResolvedValue({});
    const service = new UploadService({
      get: (key: string) =>
        (
          ({
            MINIO_ENDPOINT: 'http://localhost:9000',
            MINIO_ACCESS_KEY: 'minioadmin',
            MINIO_SECRET_KEY: 'minioadmin123',
            MINIO_BUCKET: 'circle',
            MINIO_PUBLIC_URL: 'http://localhost:9000',
          }) as Record<string, string>
        )[key] ?? null,
    } as any);

    (service as any).client = { send };

    await service.onModuleInit();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].constructor.name).toBe('HeadBucketCommand');
    expect(send.mock.calls[1][0].constructor.name).toBe(
      'PutBucketPolicyCommand',
    );
    expect(send.mock.calls[1][0].input).toMatchObject({
      Bucket: 'circle',
      Policy: buildPublicReadBucketPolicy('circle'),
    });
  });

  it('signs upload urls with the public MinIO host when configured', async () => {
    const signedUrlMock = jest.mocked(getSignedUrl);
    signedUrlMock.mockResolvedValueOnce(
      `${privateMinioUrl}/circle/avatars/test.jpeg?signature=123`,
    );

    const service = new UploadService({
      get: (key: string) =>
        (
          ({
            MINIO_ENDPOINT: 'http://localhost:9000',
            MINIO_ACCESS_KEY: 'minioadmin',
            MINIO_SECRET_KEY: 'minioadmin123',
            MINIO_BUCKET: 'circle',
            MINIO_PUBLIC_URL: privateMinioUrl,
          }) as Record<string, string>
        )[key] ?? null,
    } as any);

    const result = await service.presign(
      'avatar.jpeg',
      'image/jpeg',
      'avatars',
    );
    const signingClient = signedUrlMock.mock.calls[0]?.[0] as {
      config: { endpoint: () => Promise<{ hostname: string }> };
    };
    const signingEndpoint = await signingClient.config.endpoint();

    expect(signingEndpoint.hostname).toBe(privateMinioHost);
    expect(result.uploadUrl).toBe(
      `${privateMinioUrl}/circle/avatars/test.jpeg?signature=123`,
    );
    expect(
      result.fileUrl.startsWith(`${privateMinioUrl}/circle/avatars/`),
    ).toBe(true);
    expect(result.fileUrl.endsWith('.jpeg')).toBe(true);
  });

  it('rejects downloads whose content length exceeds the caller byte cap', async () => {
    const service = new UploadService({
      get: (key: string) =>
        (
          ({
            MINIO_ENDPOINT: 'http://localhost:9000',
            MINIO_ACCESS_KEY: 'minioadmin',
            MINIO_SECRET_KEY: 'minioadmin123',
            MINIO_BUCKET: 'circle',
            MINIO_PUBLIC_URL: 'http://localhost:9000',
          }) as Record<string, string>
        )[key] ?? null,
    } as any);
    const destroy = jest.fn();
    const send = jest.fn().mockResolvedValue({
      ContentLength: 10,
      Body: { destroy },
    });
    (service as any).client = { send };

    await expect(
      service.downloadObjectBuffer('notes/user-1/large.jpg', 5),
    ).rejects.toThrow('Object exceeds maximum download size');
    expect(destroy).toHaveBeenCalled();
  });

  it('stops streaming downloads when chunks exceed the caller byte cap', async () => {
    const service = new UploadService({
      get: (key: string) =>
        (
          ({
            MINIO_ENDPOINT: 'http://localhost:9000',
            MINIO_ACCESS_KEY: 'minioadmin',
            MINIO_SECRET_KEY: 'minioadmin123',
            MINIO_BUCKET: 'circle',
            MINIO_PUBLIC_URL: 'http://localhost:9000',
          }) as Record<string, string>
        )[key] ?? null,
    } as any);
    const destroy = jest.fn();
    async function* chunks() {
      yield Buffer.alloc(3);
      yield Buffer.alloc(3);
    }
    const body = Object.assign(chunks(), { destroy });
    const send = jest.fn().mockResolvedValue({
      Body: body,
    });
    (service as any).client = { send };

    await expect(
      service.downloadObjectBuffer('notes/user-1/stream.jpg', 5),
    ).rejects.toThrow('Object exceeds maximum download size');
    expect(destroy).toHaveBeenCalled();
  });
});
