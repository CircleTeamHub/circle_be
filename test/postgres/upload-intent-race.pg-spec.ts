import { UploadIntentService } from 'src/upload/upload-intent.service';
import {
  createUsers,
  type CircleTxDb,
  openCircleTxDb,
} from './circle-tx-harness';
import { describePostgres } from './pg-test-db';

describePostgres(
  'upload-intent claim and reclamation races (PostgreSQL)',
  () => {
    let t: CircleTxDb;
    let userID: string;
    const deleteObjectByKey = jest.fn().mockResolvedValue(undefined);
    const objectKeyFromPublicUrl = (value: string) => {
      try {
        return new URL(value).pathname.replace(/^\/+/, '');
      } catch {
        return null;
      }
    };

    const service = () =>
      new UploadIntentService(
        t.prisma as never,
        { deleteObjectByKey, objectKeyFromPublicUrl } as never,
        { get: () => 'delete' } as never,
      );

    const createIntent = (objectKey: string, now: Date) =>
      t.prisma.uploadIntent.create({
        data: {
          objectKey,
          fileUrl: `https://cdn.example.test/${objectKey}`,
          userID,
          purpose: 'PROFILE_AVATAR',
          folder: 'avatars',
          sizeBytes: 12,
          expiresAt: new Date(now.getTime() - 1),
        },
      });

    beforeAll(async () => {
      t = await openCircleTxDb('upload_intent_race');
      [userID] = await createUsers(t.prisma, 1);
    }, 60_000);

    beforeEach(async () => {
      deleteObjectByKey.mockClear();
      await t.prisma.uploadIntent.deleteMany();
      await t.prisma.user.update({
        where: { id: userID },
        data: { avatarUrl: null },
      });
    });

    afterAll(async () => {
      await t?.close();
    });

    it('does not lease or delete after the business claim commits first', async () => {
      const now = new Date();
      const key = `avatars/${userID}/claim-first.jpg`;
      await createIntent(key, now);

      await t.prisma.$transaction(async (tx) => {
        await service().claim(tx, userID, 'PROFILE_AVATAR', [
          `https://cdn.example.test/${key}`,
        ]);
        await tx.user.update({
          where: { id: userID },
          data: { avatarUrl: `https://cdn.example.test/${key}` },
        });
      });
      await service().reclaim(new Set(), now);

      await expect(
        t.prisma.uploadIntent.findUniqueOrThrow({ where: { objectKey: key } }),
      ).resolves.toMatchObject({ status: 'CLAIMED' });
      expect(deleteObjectByKey).not.toHaveBeenCalled();
    });

    it('rejects the business write after reclamation owns and completes deletion', async () => {
      const now = new Date();
      const key = `avatars/${userID}/gc-first.jpg`;
      await createIntent(key, now);
      await service().reclaim(new Set(), now);

      await expect(
        t.prisma.$transaction(async (tx) => {
          await service().claim(tx, userID, 'PROFILE_AVATAR', [key]);
          await tx.user.update({
            where: { id: userID },
            data: { avatarUrl: `https://cdn.example.test/${key}` },
          });
        }),
      ).rejects.toThrow('上传已过期，请重新选择');

      await expect(
        t.prisma.user.findUniqueOrThrow({ where: { id: userID } }),
      ).resolves.toMatchObject({ avatarUrl: null });
      await expect(
        t.prisma.uploadIntent.findUniqueOrThrow({ where: { objectKey: key } }),
      ).resolves.toMatchObject({ status: 'DELETED' });
    });

    it('retries an idempotent object deletion after a failed leased write-back', async () => {
      const now = new Date();
      const key = `avatars/${userID}/writeback-retry.jpg`;
      await createIntent(key, now);
      const delegate = t.prisma.uploadIntent;
      const originalUpdateMany = delegate.updateMany.bind(delegate);
      let failDeletedWriteBack = true;
      const updateSpy = jest
        .spyOn(delegate as any, 'updateMany')
        .mockImplementation(async (args: any) => {
          if (args.data.status === 'DELETED' && failDeletedWriteBack) {
            failDeletedWriteBack = false;
            throw new Error('database write-back unavailable');
          }
          return originalUpdateMany(args);
        });

      try {
        await service().reclaim(new Set(), now);
        const leased = await t.prisma.uploadIntent.findUniqueOrThrow({
          where: { objectKey: key },
        });
        expect(leased).toMatchObject({ status: 'DELETING' });

        await service().reclaim(
          new Set(),
          new Date(leased.deleteLeaseUntil!.getTime() + 1),
        );

        await expect(
          t.prisma.uploadIntent.findUniqueOrThrow({
            where: { objectKey: key },
          }),
        ).resolves.toMatchObject({ status: 'DELETED' });
        expect(deleteObjectByKey).toHaveBeenCalledTimes(2);
      } finally {
        updateSpy.mockRestore();
      }
    });

    it('enforces the object-key uniqueness and due-scan index from the schema', async () => {
      const now = new Date();
      const key = `avatars/${userID}/unique.jpg`;
      await createIntent(key, now);
      await expect(createIntent(key, now)).rejects.toMatchObject({
        code: 'P2002',
      });

      const db = await t.rawClient();
      try {
        const indexes = await db.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
         WHERE schemaname = $1 AND tablename = 'UploadIntent'`,
          [t.schema],
        );
        expect(indexes.rows.map((row) => row.indexname)).toEqual(
          expect.arrayContaining([
            'UploadIntent_objectKey_key',
            'UploadIntent_status_expiresAt_idx',
          ]),
        );
      } finally {
        await db.end();
      }
    });
  },
);
