import { ChatMediaService } from '../chat/chat-media.service';
import type { ChatMessageDto } from '../chat/chat.types';
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
    await service.onModuleInit();
    expect(service.objectStoreStatus()).toBe('ok');
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
  it('expires the original user grant at burn time while keeping the audit attachment stored', async () => {
    const body = Buffer.from('retained-audit-attachment');
    const upload = await service.presign(
      'retained.png',
      'image/png',
      body.length,
      'chat',
      'integration-user',
    );
    expect(
      (
        await fetch(upload.uploadUrl, {
          method: 'PUT',
          headers: upload.requiredHeaders,
          body,
        })
      ).status,
    ).toBe(200);
    const deadline = new Date(Date.now() + 4000);
    const row = {
      id: 'burn-message',
      deleted: false,
      revokedAt: null,
      burnDurationSec: 60,
      burnExpiresAt: deadline,
    };
    const tx = {
      $queryRaw: async () => [],
      chatMessage: { findMany: async () => [row] },
    };
    const media = new ChatMediaService(service, {
      $transaction: async (fn) => fn(tx),
    } as never);
    try {
      const message: ChatMessageDto = {
        height: 1,
        revision: 1,
        sender: null,
        replyToId: null,
        d: null,
        createdAt: new Date().toISOString(),
        id: row.id,
        conversationId: 'conversation',
        type: 'image',
        content: { key: upload.key },
        burnDurationSec: 60,
        burnExpiresAt: deadline.toISOString(),
      };
      await media.attachMediaUrls([message]);
      const userUrl = message.content.url as string;
      expect((await fetch(userUrl)).status).toBe(200);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, deadline.getTime() - Date.now() + 1200),
        ),
      );
      row.deleted = true;
      expect((await fetch(userUrl)).status).toBe(403);
      // Retention keeps the bytes; expiration comes from the user grant, not deletion.
      const auditGrant = await service.createPresignedGetUrl(upload.key, 30);
      expect((await fetch(auditGrant.url)).status).toBe(200);
    } finally {
      media.onModuleDestroy();
    }
  }, 20000);
});
