import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { Client } from 'pg';
import { assertEncryptedTextSend } from 'src/e2ee/e2ee-proof';
import { E2eeService } from 'src/e2ee/e2ee.service';
import { describePostgres } from './pg-test-db';
import {
  type LiveSchema,
  openLiveSchema,
  seedUsers,
  settleWithin,
  statementsAfter,
  waitUntilBlocked,
} from './live-prisma';

/**
 * 加密消息发送准入(assertEncryptedTextSend)与逐条密文归档(E2eeService 的
 * resolveArchive / writeArchive / readArchive)的锁与往返(真 PrismaClient + 真 PostgreSQL)。
 *
 * 发送:对房间设备行、审计管理员的 User / AdminAccess 行的 FOR SHARE 是刻意的安全
 * 不变式 —— 设备吊销(E2eeDevice FOR UPDATE)与管理员降权(UPDATE User / AdminAccess)
 * 必须与发送排出先后,发送不能在吊销/降权提交之后还按旧状态放行。锁保留,只把重复的
 * 设备读取、逐个管理员的三条语句、三个 count 合并:锁内 12 条 → 4 条。
 *
 * 归档:每一项都对会话行 FOR SHARE 并逐项查询,改成会话级一次加锁、逐项查询批量化;
 * 锁仍持有到事务结束(清空/移除/发送照旧排在归档写之后),可见性判定逐项不变。
 */
// 建整套表(prisma migrate diff 生成的 DDL)在共享测试库上可能要好几秒。
jest.setTimeout(60_000);

type Pair = { publicKey: string; privateKey: KeyObject };
const keyPair = (): Pair => {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey
      .export({ type: 'spki', format: 'der' })
      .subarray(-32)
      .toString('base64'),
    privateKey: pair.privateKey,
  };
};
const proof = (pair: Pair, action: string, payload: unknown) =>
  sign(
    null,
    Buffer.from(JSON.stringify(['circle-e2ee-action-v1', action, payload])),
    pair.privateKey,
  ).toString('base64');

const alicePhone = keyPair();
const bobPhone = keyPair();
const auditDevice = keyPair();
const aliceRecovery = keyPair();
const adminRecovery = keyPair();

const envelope = (
  conversationId: string,
  senderDeviceId: string,
  clientMessageId: string,
  epoch = '3',
) => ({
  version: 1,
  protocol: 'mls10',
  conversationId,
  senderDeviceId,
  clientMessageId,
  epoch,
  ciphertext: 'Y2lwaGVy',
});

describePostgres('e2ee send admission and archive batching', () => {
  let live: LiveSchema;
  let e2ee: E2eeService;
  let other: Client;

  beforeAll(async () => {
    live = await openLiveSchema('e2ee_send_archive');
    e2ee = new E2eeService(
      live.prisma as never,
      {
        get: () => 'true',
      } as never,
    );
    other = await live.connect();
  });

  afterAll(async () => {
    await live?.close();
  });

  beforeEach(async () => {
    await live.db.query(`
      TRUNCATE "User", "ChatConversation", "ChatMember", "ChatMessage", "ChatBurnArchive",
        "E2eeDevice", "E2eeRoom", "E2eeRoomDevice", "E2eeRecovery", "E2eeArchive",
        "AdminAccess", "AdminAuditLog", "AccountIdentifier" CASCADE;
    `);
    await seedUsers(live.db, ['alice', 'bob']);
    await seedUsers(live.db, ['admin'], { role: 'ADMIN' });
    await live.db.query(`
      INSERT INTO "AdminAccess" ("userID", role, "updatedAt") VALUES ('admin', 'SUPER_ADMIN', now());
      INSERT INTO "ChatConversation" (id, type, "directKey", "textEncryption", "nextHeight", "updatedAt")
      VALUES ('c1', 'DIRECT', 'alice:bob', 'MLS_V1', 9, now());
      INSERT INTO "ChatConversation" (id, type, "ownerID", "membersCanViewRoster", "textEncryption", "nextHeight", "updatedAt")
      VALUES ('c2', 'GROUP', 'alice', true, 'MLS_V1', 9, now());
      INSERT INTO "ChatMember" (id, "conversationID", "userID") VALUES
        ('c1-alice', 'c1', 'alice'), ('c1-bob', 'c1', 'bob'),
        ('c2-alice', 'c2', 'alice'), ('c2-bob', 'c2', 'bob');
    `);
    await live.db.query(
      `INSERT INTO "E2eeDevice" (id, "userID", purpose, "publicKey", label, status) VALUES
         ('alice-phone', 'alice', 'APP', $1, 'a', 'ACTIVE'),
         ('bob-phone', 'bob', 'APP', $2, 'b', 'ACTIVE'),
         ('audit-dev', 'admin', 'AUDIT', $3, 'z', 'ACTIVE')`,
      [alicePhone.publicKey, bobPhone.publicKey, auditDevice.publicKey],
    );
    await live.db.query(`
      INSERT INTO "E2eeRoom" ("conversationID", "managerDeviceID", epoch) VALUES ('c1', 'alice-phone', 3);
      INSERT INTO "E2eeRoomDevice" ("conversationID", "deviceID", "joinedEpoch") VALUES
        ('c1', 'alice-phone', 0), ('c1', 'bob-phone', 0), ('c1', 'audit-dev', 0);
    `);
    await live.db.query(
      `INSERT INTO "E2eeRecovery" (id, "userID", purpose, "publicKey") VALUES
         ('rec-alice', 'alice', 'APP', $1), ('rec-admin', 'admin', 'AUDIT', $2)`,
      [aliceRecovery.publicKey, adminRecovery.publicKey],
    );
    live.statements.length = 0;
  });

  afterEach(async () => {
    await other.query('ROLLBACK').catch(() => undefined);
  });

  describe('send admission', () => {
    const content = (d: string) => ({
      envelope: envelope('c1', 'alice-phone', d),
      signature: proof(alicePhone, 'send', [
        'alice',
        'c1',
        'alice-phone',
        d,
        '3',
        'Y2lwaGVy',
      ]),
    });
    /** 与发送事务同形:先锁会话行,再做准入。 */
    const admit = (d: string, body: Record<string, unknown> = content(d)) =>
      live.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ChatConversation" WHERE "id" = 'c1' FOR UPDATE`;
        await assertEncryptedTextSend(
          tx,
          'alice',
          'c1',
          'encrypted-text',
          d,
          body,
        );
      });
    const isConversationLock = (sql: string) =>
      /"ChatConversation"/.test(sql) && /FOR UPDATE/.test(sql);

    it('admits a valid envelope with four statements under the conversation lock', async () => {
      await admit('d1');
      const inside = statementsAfter(live.statements, isConversationLock);
      // 原来:房间(+设备 include ×2)、设备 FOR SHARE、设备再读一遍、
      // 管理员 User/AdminAccess FOR SHARE + 读权限(+include)、三个 count —— 12 条。
      expect(inside).toHaveLength(4);
      expect(inside.filter((s) => /FOR SHARE/.test(s.sql))).toHaveLength(2);
    });

    it('locks an administrator once even with several audit devices', async () => {
      await live.db.query(
        `INSERT INTO "E2eeDevice" (id, "userID", purpose, "publicKey", label, status)
         VALUES ('audit-dev-2', 'admin', 'AUDIT', $1, 'z2', 'ACTIVE')`,
        [keyPair().publicKey],
      );
      await live.db.query(
        `INSERT INTO "E2eeRoomDevice" ("conversationID", "deviceID", "joinedEpoch") VALUES ('c1', 'audit-dev-2', 0)`,
      );
      await admit('d1');
      expect(statementsAfter(live.statements, isConversationLock)).toHaveLength(
        4,
      );
    });

    it('waits for an in-flight device revocation and then rejects the send', async () => {
      await other.query('BEGIN');
      await other.query(
        `UPDATE "E2eeDevice" SET status = 'REVOKED', "revokedAt" = now() WHERE id = 'bob-phone'`,
      );
      const pending = admit('d1');
      await waitUntilBlocked(live.db, (query) => /"E2eeDevice"/.test(query));
      await other.query('COMMIT');
      await expect(pending).rejects.toThrow(
        'Remove revoked devices before sending',
      );
    });

    it('waits for an in-flight administrator demotion and then rejects the send', async () => {
      await other.query('BEGIN');
      await other.query(
        `UPDATE "AdminAccess" SET role = 'OPERATIONS' WHERE "userID" = 'admin'`,
      );
      const pending = admit('d1');
      await waitUntilBlocked(live.db, (query) => /"AdminAccess"/.test(query));
      await other.query('COMMIT');
      await expect(pending).rejects.toThrow(
        'Administrator read access revoked',
      );
    });

    it('waits for an in-flight administrator ban and then rejects the send', async () => {
      await other.query('BEGIN');
      await other.query(
        `UPDATE "User" SET status = 'BANNED' WHERE id = 'admin'`,
      );
      const pending = admit('d1');
      await waitUntilBlocked(live.db, (query) => /"User"/.test(query));
      await other.query('COMMIT');
      await expect(pending).rejects.toThrow(
        'Administrator read access revoked',
      );
    });

    it('does not make two sends sharing the audit administrator wait for each other', async () => {
      await other.query('BEGIN');
      await other.query(`SELECT id FROM "User" WHERE id = 'admin' FOR SHARE`);
      await other.query(
        `SELECT "userID" FROM "AdminAccess" WHERE "userID" = 'admin' FOR SHARE`,
      );
      expect(await settleWithin(admit('d1'), 1500)).not.toBe('pending');
      await other.query('COMMIT');
    });

    it.each([
      [
        'an administrator without IM_READ',
        `UPDATE "AdminAccess" SET role = 'OPERATIONS'`,
        'Administrator read access revoked',
      ],
      [
        'an administrator without an admin grant',
        `DELETE FROM "AdminAccess"`,
        'Administrator read access revoked',
      ],
      [
        'a member without a device in the group',
        `INSERT INTO "ChatMember" (id, "conversationID", "userID") VALUES ('c1-admin', 'c1', 'admin')`,
        'Remove former conversation members before sending',
      ],
      [
        'a device owner who left',
        `UPDATE "ChatMember" SET "leftAt" = now() WHERE id = 'c1-bob'`,
        'Remove former conversation members before sending',
      ],
      [
        'a banned device owner',
        `UPDATE "User" SET status = 'BANNED' WHERE id = 'bob'`,
        'Remove former conversation members before sending',
      ],
      [
        'no audit device',
        `UPDATE "E2eeRoomDevice" SET "removedEpoch" = 3 WHERE "deviceID" = 'audit-dev'`,
        'An authorized audit device must be included',
      ],
      [
        'a stale epoch',
        `UPDATE "E2eeRoom" SET epoch = 4`,
        'Encryption epoch changed',
      ],
    ])('keeps rejecting %s', async (_name, mutate, message) => {
      await live.db.query(mutate);
      await expect(admit('d1')).rejects.toThrow(message);
    });

    it('rejects a forged signature after all database checks', async () => {
      const forged = {
        ...content('d1'),
        signature: proof(bobPhone, 'send', ['x']),
      };
      await expect(admit('d1', forged)).rejects.toThrow(
        'Encryption device proof rejected',
      );
    });
  });

  describe('archive', () => {
    /** 每条消息的 content 都是一份合法形状的信封。 */
    const insertMessage = async (
      id: string,
      conversationId: string,
      sender: string,
      senderDevice: string,
      d: string,
      height: number,
      extra: {
        deleted?: boolean;
        revoked?: boolean;
        expired?: boolean;
        envelopeDevice?: string;
      } = {},
    ) =>
      live.db.query(
        `INSERT INTO "ChatMessage" (id, "conversationID", height, "senderID", type, content, "clientMessageId", deleted, "revokedAt", "burnExpiresAt", "burnDurationSec")
         VALUES ($1, $2, $3, $4, 'encrypted-text', $5, $6, $7, $8, $9, $10)`,
        [
          id,
          conversationId,
          height,
          sender,
          {
            envelope: envelope(
              conversationId,
              extra.envelopeDevice ?? senderDevice,
              d,
            ),
            signature: 'x',
          },
          d,
          extra.deleted ?? false,
          extra.revoked ? new Date() : null,
          extra.expired ? new Date(Date.now() - 1000) : null,
          extra.expired ? 60 : null,
        ],
      );

    beforeEach(async () => {
      await insertMessage('m1', 'c1', 'bob', 'bob-phone', 'd1', 1);
      await insertMessage('m2', 'c1', 'bob', 'bob-phone', 'd2', 2, {
        deleted: true,
      });
      await insertMessage('m3', 'c1', 'bob', 'bob-phone', 'd3', 3, {
        revoked: true,
      });
      await insertMessage('m4', 'c2', 'alice', 'alice-phone', 'd4', 1);
      await insertMessage('m5', 'c2', 'bob', 'bob-phone', 'd5', 2, {
        envelopeDevice: 'alice-phone',
      });
      await insertMessage('m6', 'c1', 'bob', 'bob-phone', 'd6', 4);
      await insertMessage('m7', 'c1', 'bob', 'bob-phone', 'd7', 5, {
        expired: true,
      });
      await insertMessage('m8', 'c2', 'bob', 'bob-phone', 'd8', 3);
      await live.db.query(
        `INSERT INTO "ChatBurnArchive" (id, "conversationID", "senderID", "clientMessageId", height, type, content, "createdAt", "burnExpiresAt", "retainUntil")
         SELECT id, "conversationID", "senderID", "clientMessageId", height, type, content, "createdAt", now(), now() + interval '30 days'
         FROM "ChatMessage" WHERE id = 'm2';
         -- 本人在 c1 的清空水位压过 m1;c2 的 bob 座位已离座(只影响 bob 自己)。
         UPDATE "ChatMember" SET "clearedBeforeHeight" = 1 WHERE id = 'c1-alice';
         UPDATE "ChatMember" SET "leftAt" = now() WHERE id = 'c2-bob';`,
      );
      live.statements.length = 0;
    });

    const refs = [
      ['c1', 'bob-phone', 'd1'],
      ['c1', 'bob-phone', 'd2'],
      ['c1', 'bob-phone', 'd3'],
      ['c2', 'alice-phone', 'd4'],
      ['c2', 'bob-phone', 'd5'],
      ['c1', 'bob-phone', 'd6'],
      ['c1', 'bob-phone', 'd7'],
      ['c2', 'bob-phone', 'd8'],
      ['c1', 'ghost-device', 'd1'],
    ].map(([conversationId, senderDeviceId, clientMessageId]) => ({
      conversationId,
      senderDeviceId,
      clientMessageId,
    }));
    const refTuples = refs.map((r) => [
      r.conversationId,
      r.senderDeviceId,
      r.clientMessageId,
    ]);

    const actorDto = (
      userID: string,
      purpose: 'APP' | 'AUDIT',
      action: string,
      values: unknown[],
    ) => {
      const device = purpose === 'APP' ? 'alice-phone' : 'audit-dev';
      const pair = purpose === 'APP' ? alicePhone : auditDevice;
      const reason = purpose === 'AUDIT' ? '调查' : undefined;
      return {
        actorDeviceId: device,
        ...(reason ? { reason } : {}),
        signature: proof(pair, action, [
          userID,
          purpose,
          device,
          ...values,
          reason ?? null,
        ]),
      };
    };

    const resolve = (userID: string, purpose: 'APP' | 'AUDIT') =>
      e2ee.resolveArchive(userID, purpose, {
        refs,
        ...actorDto(userID, purpose, 'archive-resolve', [refTuples]),
      } as never);

    const isConversationShare = (sql: string) =>
      /"ChatConversation"/.test(sql) && /FOR SHARE/.test(sql);

    it('resolves the same visible set for an application device, one conversation lock per conversation', async () => {
      const result = await resolve('alice', 'APP');
      // m1 在本人清空水位下;m2 已焚毁;m3 已撤回;m5 信封设备对不上;m7 已到期;幽灵设备无此人。
      expect(result.items.map((item) => item.messageID)).toEqual([
        'm6',
        'm4',
        'm8',
      ]);
      expect(result.items.every((item) => item.archived === false)).toBe(true);
      expect(
        live.statements.filter((s) => isConversationShare(s.sql)),
      ).toHaveLength(1);
    });

    it('resolves retained burned content for an authorized audit reader', async () => {
      const result = await resolve('admin', 'AUDIT');
      // 审计端不看座位水位;m2 走焚毁留存;m3 撤回、m7 到期不在留存里。
      expect(result.items.map((item) => item.messageID)).toEqual([
        'm1',
        'm2',
        'm6',
        'm4',
        'm8',
      ]);
      const retained = result.items.find((item) => item.messageID === 'm2');
      expect(retained?.expiresAt).not.toBeNull();
    });

    it('withholds retained content from an audit reader without archive permission', async () => {
      await live.db.query(`UPDATE "AdminAccess" SET role = 'SUPPORT'`);
      const result = await resolve('admin', 'AUDIT');
      expect(result.items.map((item) => item.messageID)).toEqual([
        'm1',
        'm6',
        'm4',
        'm8',
      ]);
    });

    const write = (
      items: Array<{
        conversationId: string;
        senderDeviceId: string;
        clientMessageId: string;
        ciphertext: string;
      }>,
    ) => {
      const values = [
        'rec-alice',
        items.map((i) => [
          i.conversationId,
          i.senderDeviceId,
          i.clientMessageId,
          i.ciphertext,
        ]),
      ];
      return e2ee.writeArchive('alice', 'APP', {
        recoveryId: 'rec-alice',
        items,
        recoverySignature: proof(aliceRecovery, 'archive-write', [
          'alice',
          'APP',
          'alice-phone',
          ...values,
          null,
        ]),
        ...actorDto('alice', 'APP', 'archive-write', values),
      } as never);
    };
    const archiveItems = refs.map((r, i) => ({
      ...r,
      ciphertext: `cipher-${i}`,
    }));

    it('writes archives for exactly the visible items, in item order, and counts repeats', async () => {
      const result = await write([...archiveItems, archiveItems[5]]);
      // m6 出现两次:第二次是 upsert 的空操作,但照旧计数。
      expect(result).toEqual({ count: 4 });
      const rows = (
        await live.db.query(
          `SELECT "messageID", ciphertext FROM "E2eeArchive" WHERE "recoveryID" = 'rec-alice' ORDER BY cursor`,
        )
      ).rows;
      // 按会话排序后的写入顺序:c1 的 m6,再 c2 的 m4、m8。
      expect(rows).toEqual([
        { messageID: 'm6', ciphertext: 'cipher-5' },
        { messageID: 'm4', ciphertext: 'cipher-3' },
        { messageID: 'm8', ciphertext: 'cipher-7' },
      ]);
      expect(
        live.statements.filter((s) => isConversationShare(s.sql)),
      ).toHaveLength(1);
      expect(
        live.statements.filter(
          (s) => /"ChatMessage"/.test(s.sql) && /FOR SHARE/.test(s.sql),
        ),
      ).toHaveLength(1);

      // 重放:已归档的不再插入,计数口径不变。
      expect(await write(archiveItems)).toEqual({ count: 3 });
      expect(
        (await live.db.query(`SELECT count(*)::int AS n FROM "E2eeArchive"`))
          .rows[0].n,
      ).toBe(3);
    });

    it('still makes a clear wait for the archive write and reads the cleared state after it', async () => {
      await other.query('BEGIN');
      await other.query(
        `SELECT id FROM "ChatConversation" WHERE id = 'c2' FOR UPDATE`,
      );
      await other.query(
        `UPDATE "ChatMember" SET "clearedBeforeHeight" = 5 WHERE id = 'c2-alice'`,
      );
      const pending = write(archiveItems);
      await waitUntilBlocked(live.db, (query) =>
        /"ChatConversation"/.test(query),
      );
      await other.query('COMMIT');
      // c2 清空之后 m4、m8 对本人不可见,只剩 c1 的 m6。
      expect(await pending).toEqual({ count: 1 });
    });

    const read = (
      userID: string,
      purpose: 'APP' | 'AUDIT',
      recoveryId: string,
      after = '',
    ) =>
      e2ee.readArchive(userID, purpose, {
        recoveryId,
        after,
        ...actorDto(userID, purpose, 'archive-read', [recoveryId, after]),
      } as never);

    it('reads back only archives that are still visible, batching the visibility checks', async () => {
      await write(archiveItems);
      // 写完之后 m8 被撤回:归档行留着(由保留触发器/清理负责),读时不再给。
      await live.db.query(
        `UPDATE "ChatMessage" SET "revokedAt" = now() WHERE id = 'm8'`,
      );
      live.statements.length = 0;

      const result = await read('alice', 'APP', 'rec-alice');
      expect(
        result.items.map((item) => [item.messageID, item.ciphertext]),
      ).toEqual([
        ['m6', 'cipher-5'],
        ['m4', 'cipher-3'],
      ]);
      expect(result.next).toBeNull();
      expect(
        live.statements.filter((s) => isConversationShare(s.sql)),
      ).toHaveLength(1);
    });

    it('reads retained audit archives through the burn archive copy', async () => {
      await live.db.query(
        `INSERT INTO "E2eeArchive" (id, "recoveryID", "messageID", ciphertext) VALUES
           ('a-m2', 'rec-admin', 'm2', 'audit-2'), ('a-m1', 'rec-admin', 'm1', 'audit-1');
         UPDATE "ChatMessage" SET content = '{}'::jsonb WHERE id = 'm2';`,
      );
      const result = await read('admin', 'AUDIT', 'rec-admin');
      expect(
        result.items.map((item) => [item.messageID, item.ciphertext]),
      ).toEqual([
        ['m2', 'audit-2'],
        ['m1', 'audit-1'],
      ]);
      expect(result.items[0].content).toMatchObject({
        envelope: { clientMessageId: 'd2' },
      });
    });
  });
});
