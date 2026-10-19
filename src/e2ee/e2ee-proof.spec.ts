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
    const devices = [
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
    tx = {
      $queryRaw: jest.fn(),
      e2eeRoom: {
        findUnique: jest.fn().mockResolvedValue({
          epoch: 2,
          devices: devices.map((d) => ({ deviceID: d.id })),
        }),
      },
      e2eeDevice: { findMany: jest.fn().mockResolvedValue(devices) },
      chatMember: { count: jest.fn().mockResolvedValue(1) },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          role: 'ADMIN',
          status: 'ACTIVE',
          adminAccess: { role: 'SUPER_ADMIN' },
        }),
        count: jest.fn().mockResolvedValue(1),
      },
    };
  });
  it('accepts a signed envelope only with current active member and administrator devices', async () => {
    await expect(check()).resolves.toBeUndefined();
    expect(tx.$queryRaw).toHaveBeenCalled();
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
    tx.e2eeRoom.findUnique.mockResolvedValue({ epoch: 3, devices: [] });
    await expect(check()).rejects.toThrow('epoch changed');
  });
  it('rejects any revoked device remaining in the group', async () => {
    tx.e2eeDevice.findMany.mockResolvedValue([
      { id: 'phone', status: 'REVOKED' },
    ]);
    await expect(check()).rejects.toThrow('revoked');
  });
  it('requires an administrator device', async () => {
    tx.e2eeDevice.findMany.mockResolvedValue([
      {
        id: 'phone',
        userID: 'alice',
        purpose: 'APP',
        status: 'ACTIVE',
        publicKey,
      },
    ]);
    await expect(check()).rejects.toThrow('audit device');
  });
  it('checks current admin database permissions', async () => {
    tx.user.findUnique.mockResolvedValue({
      role: 'ADMIN',
      status: 'ACTIVE',
      adminAccess: { role: 'OPERATIONS' },
    });
    await expect(check()).rejects.toThrow('revoked');
  });
  it('rejects departed members even with a valid group key', async () => {
    tx.chatMember.count.mockResolvedValue(0);
    await expect(check()).rejects.toThrow('members');
  });
  it('requires newly joined participants to be included', async () => {
    tx.chatMember.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await expect(check()).rejects.toThrow('members');
  });
  it('rejects a banned participant', async () => {
    tx.user.count.mockResolvedValue(0);
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
