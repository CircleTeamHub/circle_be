import { generateKeyPairSync, sign } from 'node:crypto';
import { assertEncryptedTextSend, verifyDeviceProof } from './e2ee-proof';
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('base64');
const proof = (action: string, payload: unknown) =>
  sign(
    null,
    Buffer.from(JSON.stringify(['circle-e2ee-action-v1', action, payload])),
    pair.privateKey,
  ).toString('base64');

describe('encrypted text admission', () => {
  let tx: any;
  // 锁内三条原生查询按表名分派:房间设备 FOR SHARE、审计管理员 FOR SHARE、成员计数。
  let devices: any[];
  let admins: any[];
  let counts: { seats: number; allSeats: number; activeOwners: number };
  const envelope = () => ({
    version: 1,
    protocol: 'mls10',
    conversationId: 'room',
    senderDeviceId: 'phone',
    clientMessageId: 'message',
    epoch: '2',
    ciphertext: 'Y2lwaGVy',
  });
  const content = () => ({
    envelope: envelope(),
    signature: proof('send', [
      'alice',
      'room',
      'phone',
      'message',
      '2',
      'Y2lwaGVy',
    ]),
  });
  const check = (body: any = content(), type = 'encrypted-text') =>
    assertEncryptedTextSend(tx, 'alice', 'room', type, 'message', body);
  beforeEach(() => {
    devices = [
      {
        id: 'phone',
        userID: 'alice',
        purpose: 'APP',
        status: 'ACTIVE',
        publicKey,
      },
      {
        id: 'audit',
        userID: 'admin',
        purpose: 'AUDIT',
        status: 'ACTIVE',
        publicKey,
      },
    ];
    admins = [
      {
        id: 'admin',
        role: 'ADMIN',
        status: 'ACTIVE',
        adminRole: 'SUPER_ADMIN',
      },
    ];
    counts = { seats: 1, allSeats: 1, activeOwners: 1 };
    tx = {
      $queryRaw: jest.fn(({ sql }: { sql: string }) => {
        if (sql.includes('"AdminAccess"')) return Promise.resolve(admins);
        if (sql.includes('"E2eeDevice"')) return Promise.resolve(devices);
        if (sql.includes('"ChatMember"')) return Promise.resolve([counts]);
        return Promise.resolve([]);
      }),
      e2eeRoom: { findUnique: jest.fn().mockResolvedValue({ epoch: 2 }) },
    };
  });
  const sqlCalls = () =>
    tx.$queryRaw.mock.calls.map(
      ([query]: [{ sql: string; values: unknown[] }]) => query,
    );
  it('accepts a signed envelope only with current active member and administrator devices', async () => {
    await expect(check()).resolves.toBeUndefined();
    // 设备与审计管理员仍然 FOR SHARE(与吊销/降权排出先后),各一条语句。
    const [deviceLock, adminLock, seatCounts] = sqlCalls();
    expect(deviceLock.sql).toContain('FOR SHARE');
    expect(adminLock.sql).toContain('FOR SHARE');
    expect(adminLock.sql).toContain('JOIN "AdminAccess"');
    expect(seatCounts.values).toEqual([['alice'], ['alice'], 'room']);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
  });
  it('locks and checks each audit administrator once, whatever the device count', async () => {
    devices.push({
      id: 'audit-2',
      userID: 'admin',
      purpose: 'AUDIT',
      status: 'ACTIVE',
      publicKey,
    });
    await expect(check()).resolves.toBeUndefined();
    const adminLocks = sqlCalls().filter((query: { sql: string }) =>
      query.sql.includes('"AdminAccess"'),
    );
    expect(adminLocks).toHaveLength(1);
    expect(adminLocks[0].values).toEqual([['admin']]);
  });
  it.each(['text', 'quote'])(
    'rejects plaintext %s after enabling encryption',
    async (type) => {
      await expect(check({ text: 'secret' }, type)).rejects.toThrow(
        'requires encrypted text',
      );
    },
  );
  it('leaves non-text media support intact', async () => {
    await expect(
      check({ key: 'chat/alice/image' }, 'image'),
    ).resolves.toBeUndefined();
  });
  it('rejects plaintext hidden beside ciphertext', async () => {
    await expect(check({ ...content(), text: 'side channel' })).rejects.toThrow(
      'Unexpected',
    );
  });
  it.each([
    'conversationId',
    'senderDeviceId',
    'clientMessageId',
    'epoch',
    'ciphertext',
  ])('rejects tampered %s', async (key) => {
    const value = content();
    (value.envelope as any)[key] = 'changed';
    await expect(check(value)).rejects.toThrow();
  });
  it('rejects unknown envelope keys', async () => {
    await expect(
      check({
        ...content(),
        envelope: { ...envelope(), privateKey: 'not allowed' },
      }),
    ).rejects.toThrow();
  });
  it('rejects an old epoch even with a valid device signature', async () => {
    tx.e2eeRoom.findUnique.mockResolvedValue({ epoch: 3 });
    await expect(check()).rejects.toThrow('epoch changed');
  });
  it('rejects any revoked device remaining in the group', async () => {
    devices = [{ id: 'phone', status: 'REVOKED' }];
    await expect(check()).rejects.toThrow('revoked');
  });
  it('requires an administrator device', async () => {
    devices = [
      {
        id: 'phone',
        userID: 'alice',
        purpose: 'APP',
        status: 'ACTIVE',
        publicKey,
      },
    ];
    await expect(check()).rejects.toThrow('audit device');
  });
  it('checks current admin database permissions', async () => {
    admins = [
      { id: 'admin', role: 'ADMIN', status: 'ACTIVE', adminRole: 'OPERATIONS' },
    ];
    await expect(check()).rejects.toThrow('revoked');
  });
  it('treats an administrator without an admin grant row as revoked', async () => {
    admins = [];
    await expect(check()).rejects.toThrow('Administrator read access revoked');
  });
  it('rejects departed members even with a valid group key', async () => {
    counts = { seats: 0, allSeats: 1, activeOwners: 1 };
    await expect(check()).rejects.toThrow('members');
  });
  it('requires newly joined participants to be included', async () => {
    counts = { seats: 1, allSeats: 2, activeOwners: 1 };
    await expect(check()).rejects.toThrow('members');
  });
  it('rejects a banned participant', async () => {
    counts = { seats: 1, allSeats: 1, activeOwners: 0 };
    await expect(check()).rejects.toThrow('members');
  });
  it('cannot reuse an approval proof for revocation or a different account', () => {
    const signature = proof('approve', ['alice', 'laptop']);
    expect(() =>
      verifyDeviceProof(publicKey, 'approve', ['alice', 'laptop'], signature),
    ).not.toThrow();
    expect(() =>
      verifyDeviceProof(publicKey, 'revoke', ['alice', 'laptop'], signature),
    ).toThrow();
    expect(() =>
      verifyDeviceProof(publicKey, 'approve', ['bob', 'laptop'], signature),
    ).toThrow();
  });
});
