import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { HttpResponse } from '@smithy/protocol-http';
import { instrumentObjectStorageClient } from './object-storage-metrics';

type Reply = { status: number; body?: string } | Error;

/**
 * 真实的 S3Client + 假的 HTTP 层：钉住 middleware 挂的位置 —— 包住真实请求、
 * 能看到服务端错误，但看不到只在本地签名、从不发请求的预签名。
 */
function clientReplying(replies: Reply[]) {
  const record = jest.fn();
  const client = new S3Client({
    endpoint: 'https://storage.example.test',
    region: 'us-east-1',
    credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
    forcePathStyle: true,
    maxAttempts: 1,
    requestHandler: {
      handle: () => {
        const reply = replies.shift();
        if (!reply) throw new Error('unexpected request');
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve({
          response: new HttpResponse({
            statusCode: reply.status,
            headers: { 'content-type': 'application/xml' },
            body: Readable.from([Buffer.from(reply.body ?? '')]),
          }),
        });
      },
    },
  });
  instrumentObjectStorageClient(client, record);
  return { client, record };
}

describe('instrumentObjectStorageClient', () => {
  it('records successful requests by operation', async () => {
    const { client, record } = clientReplying([{ status: 200 }]);

    await client.send(
      new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'x' }),
    );

    expect(record).toHaveBeenCalledWith(
      'object_storage',
      'PutObject',
      'success',
    );
  });

  it('treats a missing object as not_found, not a failure', async () => {
    // 「看一下对象在不在」是正常操作：算成失败的话，存储审计一跑失败率就爆表。
    const { client, record } = clientReplying([{ status: 404 }]);

    await expect(
      client.send(new HeadObjectCommand({ Bucket: 'b', Key: 'missing' })),
    ).rejects.toBeDefined();

    expect(record).toHaveBeenCalledWith(
      'object_storage',
      'HeadObject',
      'not_found',
    );
  });

  it('treats a missing bucket as a failure — that is misconfiguration', async () => {
    const { client, record } = clientReplying([{ status: 404 }]);

    await expect(
      client.send(new HeadBucketCommand({ Bucket: 'gone' })),
    ).rejects.toBeDefined();

    expect(record).toHaveBeenCalledWith(
      'object_storage',
      'HeadBucket',
      'failure',
    );
  });

  it('records server errors, access denials and network errors as failures', async () => {
    const { client, record } = clientReplying([
      {
        status: 500,
        body: '<Error><Code>InternalError</Code><Message>x</Message></Error>',
      },
      {
        status: 403,
        body: '<Error><Code>AccessDenied</Code><Message>x</Message></Error>',
      },
      new Error('connect ECONNREFUSED 10.0.0.1:9000'),
    ]);

    for (let i = 0; i < 3; i += 1) {
      await expect(
        client.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' })),
      ).rejects.toBeDefined();
    }

    expect(record.mock.calls).toEqual([
      ['object_storage', 'GetObject', 'failure'],
      ['object_storage', 'GetObject', 'failure'],
      ['object_storage', 'GetObject', 'failure'],
    ]);
  });

  it('does not count presigning, which never leaves the process', async () => {
    const { client, record } = clientReplying([]);

    await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: 'b', Key: 'k' }),
      { expiresIn: 60 },
    );

    expect(record).not.toHaveBeenCalled();
  });

  it('never lets a broken metrics sink change the request outcome', async () => {
    const { client, record } = clientReplying([{ status: 200 }]);
    record.mockImplementation(() => {
      throw new Error('registry gone');
    });

    await expect(
      client.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'x' })),
    ).resolves.toBeDefined();
  });
});
