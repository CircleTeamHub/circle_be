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
            'arn:aws:s3:::circle/friends/*',
            'arn:aws:s3:::circle/uploads/*',
          ],
        },
      ],
    });
    expect(JSON.stringify(policy)).not.toContain('note-exports');
    // notes/* 不再匿名公开：私有笔记(available:false)的媒体改由读取时的短时签名 URL
    // 提供(见 note.service 的 presign-on-read)。
    expect(JSON.stringify(policy)).not.toContain('circle/notes/*');
    // chat/* 同理：自研聊天栈存 key 不存 URL，读取走 ChatMediaService 的 presign-on-read。
    // 一旦回潮，发送侧的 chat/{senderId}/ 归属校验和读取侧的短时签名会同时失效 ——
    // 拿到过 key 的人可以绕过会话成员校验直连对象存储，所以这条断言不能删。
    expect(JSON.stringify(policy)).not.toContain('circle/chat/*');
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
    (service as any).ready = true;

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

  // 桶策略是白名单且 notes/ 已被移出 —— 「应用策略」正是让私有笔记媒体变私有的
  // 那个动作。它在启动时是 best-effort：失败只打日志、应用照常起来，旧策略继续
  // 生效、桶仍匿名可读，而读取路径照发预签名 URL。这个「以为修好了其实没修」的
  // 状态必须能被 readiness 探针观测到。
  describe('objectStoreStatus', () => {
    const buildService = (send: jest.Mock) => {
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
      return service;
    };
    const muteLogger = (service: UploadService) => {
      (service as any).logger = {
        error: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
      };
    };

    it('reports ok once the bucket policy is applied', async () => {
      const service = buildService(jest.fn().mockResolvedValue({}));

      await service.onModuleInit();

      expect(service.objectStoreStatus()).toBe('ok');
    });

    it('reports policy-unconfirmed when applying the policy failed', async () => {
      // MinIO 启动时不可达 / 缺 s3:PutBucketPolicy 权限。
      const service = buildService(
        jest
          .fn()
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(new Error('nope')),
      );
      muteLogger(service);

      await service.onModuleInit();

      expect(service.objectStoreStatus()).toBe('policy-unconfirmed');
    });

    it('creates the bucket when HeadBucket reports that it is missing', async () => {
      const missingBucket = Object.assign(new Error(''), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });
      const send = jest
        .fn()
        .mockRejectedValueOnce(missingBucket)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      const service = buildService(send);
      muteLogger(service);

      await service.onModuleInit();

      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[0][0].constructor.name).toBe('HeadBucketCommand');
      expect(send.mock.calls[1][0].constructor.name).toBe(
        'CreateBucketCommand',
      );
      expect(send.mock.calls[2][0].constructor.name).toBe(
        'PutBucketPolicyCommand',
      );
      expect(service.objectStoreStatus()).toBe('ok');
    });

    it('logs AWS error metadata when the SDK error message is blank', async () => {
      const policyError = Object.assign(new Error(''), {
        name: 'AccessDenied',
        Code: 'AccessDenied',
        $metadata: {
          httpStatusCode: 403,
          requestId: 'req-123',
          attempts: 1,
          totalRetryDelay: 0,
        },
      });
      const service = buildService(
        jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(policyError),
      );
      const logger = {
        error: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
      };
      (service as any).logger = logger;

      await service.onModuleInit();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'MinIO bootstrap attempt failed during put_bucket_policy: name=AccessDenied code=AccessDenied status=403 requestId=req-123 attempts=1',
        ),
        expect.any(String),
      );
    });

    it('does not try to create the bucket when HeadBucket fails for a non-missing bucket error', async () => {
      const headError = Object.assign(new Error(''), {
        name: 'AccessDenied',
        Code: 'AccessDenied',
        $metadata: { httpStatusCode: 403, requestId: 'head-req' },
      });
      const send = jest.fn().mockRejectedValueOnce(headError);
      const service = buildService(send);
      const logger = {
        error: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
      };
      (service as any).logger = logger;

      await service.onModuleInit();

      expect(send).toHaveBeenCalledTimes(1);
      expect(logger.log).not.toHaveBeenCalledWith(
        expect.stringContaining('not found'),
      );
      expect(service.objectStoreStatus()).toBe('policy-unconfirmed');
    });

    it('reports disabled when MinIO is not configured at all', () => {
      const service = new UploadService({ get: () => null } as any);

      expect(service.objectStoreStatus()).toBe('disabled');
    });
  });

  it('rejects production startup when the bucket policy cannot be applied', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('policy denied'));
    const service = new UploadService({
      get: (key: string) =>
        ({
          NODE_ENV: 'production',
          MINIO_ENDPOINT: 'http://localhost:9000',
          MINIO_ACCESS_KEY: 'minioadmin',
          MINIO_SECRET_KEY: 'minioadmin123',
          MINIO_BUCKET: 'circle',
          MINIO_PUBLIC_URL: 'http://localhost:9000',
        })[key] ?? null,
    } as any);
    (service as any).client = { send };
    (service as any).logger = {
      error: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
    };

    await expect(service.onModuleInit()).rejects.toMatchObject({
      status: 503,
    });
  });

  it('rejects production startup when MinIO is not configured', async () => {
    const service = new UploadService({
      get: (key: string) => (key === 'NODE_ENV' ? 'production' : null),
    } as any);

    await expect(service.onModuleInit()).rejects.toMatchObject({ status: 503 });
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
    (service as any).ready = true;

    const result = await service.presign(
      'avatar.jpeg',
      'image/jpeg',
      1024,
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
    const command = signedUrlMock.mock.calls[0]?.[1] as {
      input: { ContentLength?: number; IfNoneMatch?: string };
    };
    expect(command.input.ContentLength).toBe(1024);
    expect(command.input.IfNoneMatch).toBe('*');
    expect(signedUrlMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        signableHeaders: new Set(['content-type']),
      }),
    );
    expect(result.requiredHeaders).toEqual({
      'Content-Type': 'image/jpeg',
      'Content-Length': '1024',
      'If-None-Match': '*',
    });
  });

  // 访客那份 filename 正则为了放行 Unicode 名称,只禁路径分隔符与控制字符 ——
  // `?`/`#`/空格照样能进来。扩展名会裸拼进 object key 与 fileUrl,不在这里收口
  // 就会造出解析错位的 URL。
  it('sanitizes the filename extension before it reaches the object key', async () => {
    const service = new UploadService({
      get: (key: string) =>
        ({
          MINIO_ENDPOINT: 'http://localhost:9000',
          MINIO_ACCESS_KEY: 'minioadmin',
          MINIO_SECRET_KEY: 'minioadmin123',
          MINIO_BUCKET: 'circle',
          MINIO_PUBLIC_URL: 'https://api.example.com',
        })[key] ?? null,
    } as any);
    (service as any).ready = true;

    const hostile = await service.presign(
      '\u6d4b\u8bd5 clip.mp4?x=1#frag',
      'video/mp4',
      1024,
      'chat',
      'guest-1',
    );
    expect(hostile.key).toMatch(/^chat\/guest-1\/[0-9a-f-]{36}\.mp4x1frag$/);
    expect(hostile.fileUrl).toBe(
      `https://api.example.com/circle/${hostile.key}`,
    );

    const noExtension = await service.presign(
      '\u6d4b\u8bd5',
      'image/jpeg',
      1024,
      'chat',
      'guest-1',
    );
    expect(noExtension.key).toMatch(/^chat\/guest-1\/[0-9a-f-]{36}\.bin$/);
  });

  it('rejects oversized images before signing', async () => {
    const callsBefore = jest.mocked(getSignedUrl).mock.calls.length;
    const service = new UploadService({
      get: (key: string) =>
        ({
          MINIO_ENDPOINT: 'http://localhost:9000',
          MINIO_ACCESS_KEY: 'minioadmin',
          MINIO_SECRET_KEY: 'minioadmin123',
          MINIO_BUCKET: 'circle',
          MINIO_PUBLIC_URL: 'https://api.example.com',
        })[key] ?? null,
    } as any);
    (service as any).ready = true;

    await expect(
      service.presign('huge.jpg', 'image/jpeg', 20 * 1024 * 1024 + 1, 'posts'),
    ).rejects.toMatchObject({ status: 413 });
    expect(jest.mocked(getSignedUrl)).toHaveBeenCalledTimes(callsBefore);
  });

  it('fails presign closed while bucket bootstrap is unavailable', async () => {
    const service = new UploadService({
      get: (key: string) =>
        ({
          MINIO_ENDPOINT: 'http://localhost:9000',
          MINIO_ACCESS_KEY: 'minioadmin',
          MINIO_SECRET_KEY: 'minioadmin123',
          MINIO_BUCKET: 'circle',
        })[key] ?? null,
    } as any);
    const bootstrap = jest
      .spyOn(service as any, 'bootstrap')
      .mockResolvedValue(false);

    await expect(
      service.presign('asset.png', 'image/png', 10, 'posts'),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      service.presign('asset.png', 'image/png', 10, 'posts'),
    ).rejects.toMatchObject({ status: 503 });
    expect(bootstrap).toHaveBeenCalledTimes(1);
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

  it('createPresignedGetUrl forwards a fixed signingDate so windowed URLs stay byte-identical', async () => {
    const signedUrlMock = jest.mocked(getSignedUrl);
    signedUrlMock.mockClear();
    signedUrlMock.mockResolvedValueOnce(
      `${privateMinioUrl}/circle/notes/u/x.jpg?X-Amz-Signature=abc`,
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

    const signingDate = new Date('2026-07-17T10:00:00.000Z');
    const result = await service.createPresignedGetUrl(
      'notes/u/x.jpg',
      7200,
      signingDate,
    );

    // 传入固定 signingDate → 同窗口内同一 key 的 X-Amz-Date/签名不变 → URL 字节相同，
    // 客户端(expo-image)按-URL 缓存才能命中，否则每次刷新重下所有笔记图。
    expect(signedUrlMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ expiresIn: 7200, signingDate }),
    );
    expect(result.url).toBe(
      `${privateMinioUrl}/circle/notes/u/x.jpg?X-Amz-Signature=abc`,
    );
  });

  it('objectKeyFromPublicUrl reverses a fileUrl and strips any signature query', () => {
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

    expect(
      service.objectKeyFromPublicUrl(`${privateMinioUrl}/circle/notes/u/x.jpg`),
    ).toBe('notes/u/x.jpg');
    // 读取路径给回的会是签名 url，反推 key 时必须 strip query。
    expect(
      service.objectKeyFromPublicUrl(
        `${privateMinioUrl}/circle/notes/u/x.jpg?X-Amz-Signature=abc&X-Amz-Date=1`,
      ),
    ).toBe('notes/u/x.jpg');
    // off-origin / 空 → null（不误把外链当成本站 key）。
    expect(
      service.objectKeyFromPublicUrl(
        'https://evil.example.com/circle/notes/x.jpg',
      ),
    ).toBeNull();
    expect(service.objectKeyFromPublicUrl(null)).toBeNull();
    expect(service.objectKeyFromPublicUrl(undefined)).toBeNull();
  });

  it('copies a private object without exposing a new public URL', async () => {
    const send = jest.fn().mockResolvedValue({});
    const service = new UploadService({
      get: (key: string) =>
        ({
          MINIO_ENDPOINT: privateMinioUrl,
          MINIO_ACCESS_KEY: 'ak',
          MINIO_SECRET_KEY: 'sk',
          MINIO_BUCKET: 'circle',
          MINIO_PUBLIC_URL: privateMinioUrl,
        })[key],
    } as never);
    (service as any).enabled = true;
    (service as any).ready = true;
    (service as any).client = { send };

    await service.copyObjectByKey(
      'chat/u2/source image.jpg',
      'chat/u1/copied.jpg',
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].constructor.name).toBe('CopyObjectCommand');
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: 'circle',
      Key: 'chat/u1/copied.jpg',
      CopySource: 'circle/chat/u2/source%20image.jpg',
    });
  });

  // 自研聊天接受 voice / file 消息,并要求它们带 chat/{userId}/ 的 object key ——
  // 而唯一能签出这种 key 的 presign 此前只放行 image/video:这两个"已支持"的
  // 消息类型在拿到上传授权之前就被拒了,实际根本发不出去。
  it('presigns voice and document uploads for the chat folder', async () => {
    const service = new UploadService({
      get: (key: string) =>
        ({
          MINIO_ENDPOINT: privateMinioUrl,
          MINIO_ACCESS_KEY: 'ak',
          MINIO_SECRET_KEY: 'sk',
          MINIO_BUCKET: 'circle',
          MINIO_PUBLIC_URL: privateMinioUrl,
        })[key],
    } as never);
    (service as any).enabled = true;
    (service as any).ready = true;
    jest.mocked(getSignedUrl).mockResolvedValue('https://signed.example/put');

    await expect(
      service.presign('note.m4a', 'audio/mp4', 1024, 'chat', 'user-1'),
    ).resolves.toMatchObject({ key: expect.stringContaining('chat/user-1/') });
    await expect(
      service.presign('spec.pdf', 'application/pdf', 1024, 'chat', 'user-1'),
    ).resolves.toMatchObject({ key: expect.stringContaining('chat/user-1/') });
  });

  // DTO 的白名单是全局的:只放宽它等于让头像/封面/圈子帖目录也能收 pdf、zip。
  // 目录收口必须在 service 里再做一次。
  it.each(['avatars', 'posts', 'notes', 'friends'])(
    'refuses chat-only content types in the %s folder',
    async (folder) => {
      const service = new UploadService({
        get: (key: string) =>
          ({
            MINIO_ENDPOINT: privateMinioUrl,
            MINIO_ACCESS_KEY: 'ak',
            MINIO_SECRET_KEY: 'sk',
            MINIO_BUCKET: 'circle',
            MINIO_PUBLIC_URL: privateMinioUrl,
          })[key],
      } as never);
      (service as any).enabled = true;
      (service as any).ready = true;

      await expect(
        service.presign('x.pdf', 'application/pdf', 1024, folder, 'user-1'),
      ).rejects.toMatchObject({
        response: { errorCode: 'UPLOAD_INVALID_CONTENT_TYPE' },
      });
    },
  );
});
