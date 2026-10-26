import { ChatErrorCode } from 'src/common/app-error-codes';
import { E2eeService } from './e2ee.service';

function fixture() {
  const tx = {
    e2eeDevice: { findMany: jest.fn().mockResolvedValue([]) },
    e2eeRecovery: {
      findUnique: jest.fn().mockResolvedValue({ id: 'recovery' }),
    },
    e2eeArchive: {
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
    },
  };
  const service = new E2eeService(
    { $transaction: (work) => work(tx) } as any,
    {} as any,
  );
  jest.spyOn(service as any, 'account').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'archiveActor').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'visibleArchiveMessage').mockResolvedValue({});
  return { service, tx };
}

it('lists current devices without letting revoked history consume their limit', async () => {
  const { service, tx } = fixture();
  await service.devices('user', 'APP');
  expect(tx.e2eeDevice.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { userID: 'user', purpose: 'APP', status: { not: 'REVOKED' } },
    }),
  );
});

it('continues archive reads after a lower-hash message is inserted', async () => {
  const { service, tx } = fixture();
  tx.e2eeArchive.findMany.mockResolvedValueOnce(
    Array.from({ length: 20 }, (_, i) => ({
      id: 'f'.repeat(64),
      cursor: BigInt(i + 1),
      ciphertext: 'cipher',
      message: { content: { envelope: { clientMessageId: 'old' } } },
    })) as any,
  );
  const first = await service.readArchive('user', 'APP', {
    recoveryId: 'recovery',
    after: '',
  } as any);
  expect(first.next).toBe('v1:00000000000000000020');
  tx.e2eeArchive.findMany.mockResolvedValueOnce([
    {
      id: '0'.repeat(64),
      cursor: BigInt(21),
      ciphertext: 'new',
      message: { content: { envelope: { clientMessageId: 'new' } } },
    },
  ] as any);
  const next = await service.readArchive('user', 'APP', {
    recoveryId: 'recovery',
    after: first.next,
  } as any);
  expect(tx.e2eeArchive.findMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: { recoveryID: 'recovery', cursor: { gt: BigInt(20) } },
      orderBy: { cursor: 'asc' },
    }),
  );
  expect(next.items[0].ciphertext).toBe('new');
});

it('a demoted audit reader cannot erase retained recovery ciphertext', async () => {
  const { service, tx } = fixture();
  tx.e2eeArchive.findMany.mockResolvedValue([
    {
      id: 'retained',
      cursor: BigInt(1),
      messageID: 'm1',
      ciphertext: 'secret',
      message: { content: { envelope: { clientMessageId: 'd1' } } },
    },
  ] as any);
  jest.mocked((service as any).visibleArchiveMessage).mockResolvedValue(null);
  const result = await service.readArchive('demoted-admin', 'AUDIT', {
    recoveryId: 'recovery',
    after: '',
  } as any);
  expect(result.items).toEqual([]);
  expect(tx.e2eeArchive.delete).not.toHaveBeenCalled();
});

it('uses the authorized retention deadline for recovered audit ciphertext', async () => {
  const { service, tx } = fixture();
  const retainUntil = new Date(Date.now() + 86400_000);
  tx.e2eeArchive.findMany.mockResolvedValue([
    {
      id: 'retained',
      cursor: BigInt(1),
      messageID: 'm1',
      ciphertext: 'secret',
      message: {
        burnExpiresAt: new Date(0),
        content: { envelope: { clientMessageId: 'd1' } },
      },
    },
  ] as any);
  jest
    .mocked((service as any).visibleArchiveMessage)
    .mockResolvedValue({ burnExpiresAt: retainUntil });
  const result = await service.readArchive('admin', 'AUDIT', {
    recoveryId: 'recovery',
    after: '',
  } as any);
  expect(result.items[0].expiresAt).toBe(retainUntil.toISOString());
});

it('refuses to switch any conversation to encrypted mode once text encryption is off', async () => {
  // 第一阶段停用:不管部署开关开没开,都不能再把会话改成加密模式。
  const db = { $transaction: jest.fn() };
  const service = new E2eeService(
    db as any,
    {
      get: () => 'true',
    } as any,
  );
  await expect(
    service.createRoom('owner', 'conversation', {
      actorDeviceId: 'device',
      signature: 'proof',
    } as any),
  ).rejects.toMatchObject({
    response: { errorCode: ChatErrorCode.TextEncryptionDisabled },
  });
  expect(db.$transaction).not.toHaveBeenCalled();
});
