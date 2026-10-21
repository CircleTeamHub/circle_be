import { BadRequestException } from '@nestjs/common';
import { E2eeService } from './e2ee.service';
import { verifyDeviceProof } from './e2ee-proof';

jest.mock('./e2ee-proof', () => ({
  requireAuditPermission: jest.fn(),
  verifyDeviceProof: jest.fn(),
}));

type Device = {
  id: string;
  userID: string;
  purpose: 'APP' | 'AUDIT';
  publicKey: string;
  label: string;
  status: 'ACTIVE' | 'PENDING' | 'REVOKED';
  approvedByID: string | null;
  approvalSignature: string | null;
  revokedAt: Date | null;
};

function fixture({
  devices = [],
  recovery = { id: 'recovery' },
}: {
  devices?: Array<Partial<Device> & Pick<Device, 'id' | 'status'>>;
  recovery?: { id: string } | null;
} = {}) {
  const deviceRows = new Map<string, Device>(
    devices.map((device) => [
      device.id,
      {
        userID: 'user',
        purpose: 'APP',
        publicKey: `public-key-${device.id}`,
        label: device.id,
        approvedByID: null,
        approvalSignature: null,
        revokedAt: null,
        ...device,
      },
    ]),
  );
  const queryLog: string[] = [];
  const userLockTails = new Map<string, Promise<void>>();
  const tx = {
    e2eeDevice: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(async ({ where: { id } }) => deviceRows.get(id)),
      count: jest.fn(
        async ({ where }) =>
          [...deviceRows.values()].filter(
            (device) =>
              device.userID === where.userID &&
              device.purpose === where.purpose &&
              device.status === where.status,
          ).length,
      ),
      update: jest.fn(async ({ where: { id }, data }) => {
        const device = deviceRows.get(id)!;
        Object.assign(device, data);
        return device;
      }),
    },
    e2eeRecovery: {
      findUnique: jest.fn(async () => recovery),
    },
    e2eeKeyPackage: { deleteMany: jest.fn() },
    adminAccess: { findUnique: jest.fn() },
    adminAuditLog: { create: jest.fn() },
    e2eeArchive: {
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
    },
  };
  const db = {
    $transaction: async (work) => {
      const releases: Array<() => void> = [];
      const transactionTx = {
        ...tx,
        $queryRaw: jest.fn(
          async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings
              .reduce(
                (text, part, index) =>
                  `${text}${part}${index < values.length ? '?' : ''}`,
                '',
              )
              .replace(/\s+/g, ' ')
              .trim();
            queryLog.push(sql);
            if (sql.includes('FROM "User"') && sql.endsWith('FOR UPDATE')) {
              const userID = String(values[0]);
              const predecessor =
                userLockTails.get(userID) ?? Promise.resolve();
              let release!: () => void;
              const held = new Promise<void>((resolve) => {
                release = resolve;
              });
              const tail = predecessor.then(() => held);
              userLockTails.set(userID, tail);
              await predecessor;
              releases.push(() => {
                release();
                if (userLockTails.get(userID) === tail)
                  userLockTails.delete(userID);
              });
            }
            return [];
          },
        ),
      };
      try {
        return await work(transactionTx);
      } finally {
        for (const release of releases) release();
      }
    },
  };
  const service = new E2eeService(db as any, {} as any);
  jest.spyOn(service as any, 'enabled').mockImplementation(() => undefined);
  jest.spyOn(service as any, 'account').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'archiveActor').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'visibleArchiveMessage').mockResolvedValue({});
  jest.mocked(verifyDeviceProof).mockClear();
  return { service, tx, deviceRows, queryLog };
}

it('rejects revoking the only active device without recovery', async () => {
  const { service, tx, queryLog } = fixture({
    devices: [{ id: 'device-1', status: 'ACTIVE' }],
    recovery: null,
  });

  await expect(
    service.deviceAction('user', 'APP', 'device-1', 'revoke', {
      actorDeviceId: 'device-1',
      signature: 'signature',
    }),
  ).rejects.toThrow(BadRequestException);

  expect(queryLog[0]).toContain('FROM "User"');
  expect(queryLog[0]).toContain('FOR UPDATE');
  expect(queryLog[1]).toContain('FROM "E2eeDevice"');
  expect(queryLog[1]).toContain('ORDER BY "id" FOR UPDATE');
  expect(tx.e2eeDevice.count).toHaveBeenCalledWith({
    where: { userID: 'user', purpose: 'APP', status: 'ACTIVE' },
  });
  expect(tx.e2eeRecovery.findUnique).toHaveBeenCalledWith({
    where: { userID_purpose: { userID: 'user', purpose: 'APP' } },
  });
  expect(tx.e2eeDevice.update).not.toHaveBeenCalled();
});

it('allows revoking the only active device when recovery exists', async () => {
  const { service, tx, deviceRows } = fixture({
    devices: [{ id: 'device-1', status: 'ACTIVE' }],
  });

  await service.deviceAction('user', 'APP', 'device-1', 'revoke', {
    actorDeviceId: 'device-1',
    signature: 'signature',
  });

  expect(tx.e2eeDevice.update).toHaveBeenCalledTimes(1);
  expect(deviceRows.get('device-1')?.status).toBe('REVOKED');
});

it('keeps one active device across concurrent self-revocations without recovery', async () => {
  const { service, deviceRows } = fixture({
    devices: [
      { id: 'device-1', status: 'ACTIVE' },
      { id: 'device-2', status: 'ACTIVE' },
    ],
    recovery: null,
  });

  const results = await Promise.allSettled([
    service.deviceAction('user', 'APP', 'device-1', 'revoke', {
      actorDeviceId: 'device-1',
      signature: 'signature-1',
    }),
    service.deviceAction('user', 'APP', 'device-2', 'revoke', {
      actorDeviceId: 'device-2',
      signature: 'signature-2',
    }),
  ]);

  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
    1,
  );
  expect(
    [...deviceRows.values()].filter((device) => device.status === 'ACTIVE'),
  ).toHaveLength(1);
});

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
