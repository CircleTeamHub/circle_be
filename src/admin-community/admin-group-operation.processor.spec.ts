import { AdminGroupOperationProcessor } from './admin-group-operation.processor';

describe('AdminGroupOperationProcessor', () => {
  const operation = {
    id: 'operation-1',
    groupID: 'group-1',
    circleID: 'circle-1',
    type: 'MUTE',
    status: 'PROCESSING',
    attempts: 1,
    maxAttempts: 5,
  };
  const prisma = {
    adminGroupOperation: {
      updateMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    circle: { update: jest.fn() },
    adminAuditLog: { create: jest.fn() },
    $transaction: jest.fn(async (callback: (client: unknown) => unknown) =>
      callback(prisma),
    ),
  };
  const openim = {
    isEnabled: jest.fn(),
    muteGroup: jest.fn(),
    unmuteGroup: jest.fn(),
    dismissGroup: jest.fn(),
  };
  let processor: AdminGroupOperationProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new AdminGroupOperationProcessor(
      prisma as never,
      openim as never,
    );
    openim.muteGroup.mockReset().mockResolvedValue(undefined);
    openim.unmuteGroup.mockReset().mockResolvedValue(undefined);
    openim.dismissGroup.mockReset().mockResolvedValue(undefined);
    prisma.adminGroupOperation.updateMany.mockResolvedValue({ count: 1 });
    openim.isEnabled.mockReturnValue(true);
    prisma.adminGroupOperation.findFirst.mockResolvedValue({
      ...operation,
      status: 'PENDING',
      attempts: 0,
    });
    prisma.adminGroupOperation.findUnique.mockResolvedValue(operation);
    prisma.adminGroupOperation.update.mockResolvedValue({
      ...operation,
      status: 'SUCCEEDED',
    });
  });

  it('mutes the OpenIM group and completes circle disabling', async () => {
    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(openim.muteGroup).toHaveBeenCalledWith('group-1');
    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { adminState: 'DISABLED' },
    });
    expect(prisma.adminGroupOperation.update).toHaveBeenCalledWith({
      where: { id: 'operation-1' },
      data: expect.objectContaining({
        status: 'SUCCEEDED',
        lastError: null,
      }),
    });
  });

  it('makes a restored circle visible only after OpenIM unmute succeeds', async () => {
    prisma.adminGroupOperation.findUnique.mockResolvedValue({
      ...operation,
      type: 'UNMUTE',
    });

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(openim.unmuteGroup).toHaveBeenCalledWith('group-1');
    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: {
        deleted: false,
        adminState: 'ACTIVE',
        adminDisabledAt: null,
        adminDisabledBy: null,
        adminDisableReason: null,
      },
    });
  });

  it('requeues a transient OpenIM failure with backoff', async () => {
    openim.muteGroup.mockRejectedValue(new Error('OpenIM timeout'));

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(prisma.adminGroupOperation.update).toHaveBeenCalledWith({
      where: { id: 'operation-1' },
      data: expect.objectContaining({
        status: 'PENDING',
        lastError: 'OpenIM timeout',
        claimedAt: null,
      }),
    });
    expect(prisma.circle.update).not.toHaveBeenCalled();
  });

  it('does not report success when OpenIM is not configured', async () => {
    openim.isEnabled.mockReturnValue(false);

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(openim.muteGroup).not.toHaveBeenCalled();
    expect(prisma.adminGroupOperation.update).toHaveBeenCalledWith({
      where: { id: 'operation-1' },
      data: expect.objectContaining({ status: 'PENDING' }),
    });
  });

  it('marks the operation and circle failed after the final attempt', async () => {
    prisma.adminGroupOperation.findUnique.mockResolvedValue({
      ...operation,
      attempts: 5,
      maxAttempts: 5,
    });
    openim.muteGroup.mockRejectedValue(new Error('OpenIM unavailable'));

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(prisma.adminGroupOperation.update).toHaveBeenCalledWith({
      where: { id: 'operation-1' },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { adminState: 'SYNC_FAILED' },
    });
  });

  it('treats dismissing an already absent group as idempotent success', async () => {
    prisma.adminGroupOperation.findUnique.mockResolvedValue({
      ...operation,
      circleID: null,
      type: 'DISMISS',
    });
    openim.dismissGroup.mockRejectedValue(
      new Error('OpenIM error: RecordNotFoundError'),
    );

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(prisma.adminGroupOperation.update).toHaveBeenCalledWith({
      where: { id: 'operation-1' },
      data: expect.objectContaining({ status: 'SUCCEEDED' }),
    });
  });

  it('marks a linked circle permanently dismissed after group dismissal', async () => {
    prisma.adminGroupOperation.findUnique.mockResolvedValue({
      ...operation,
      type: 'DISMISS',
    });

    await processor.processOne(new Date('2026-07-29T12:00:00.000Z'));

    expect(openim.dismissGroup).toHaveBeenCalledWith('group-1');
    expect(prisma.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { deleted: true, adminState: 'DISMISSED' },
    });
  });
});
