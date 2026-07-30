import { ConflictException } from '@nestjs/common';
import { AdminCommunityService } from './admin-community.service';

describe('AdminCommunityService', () => {
  const tx = {
    $executeRaw: jest.fn(),
    circle: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    adminGroupOperation: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
    adminAuditLog: { findFirst: jest.fn(), create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
    circle: { findMany: jest.fn(), count: jest.fn() },
    adminGroupOperation: { findMany: jest.fn() },
  };
  const openim = { listGroups: jest.fn() };
  let service: AdminCommunityService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AdminCommunityService(prisma as never, openim as never);
    tx.$executeRaw.mockResolvedValue(1);
    tx.circle.findFirst.mockResolvedValue(null);
    tx.adminGroupOperation.findFirst.mockResolvedValue(null);
    tx.adminAuditLog.findFirst.mockResolvedValue(null);
  });

  it('disables a circle immediately and queues a durable group mute', async () => {
    tx.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      name: '摄影爱好者',
      groupID: 'group-1',
      deleted: false,
      adminState: 'ACTIVE',
    });
    tx.circle.update.mockResolvedValue({
      id: 'circle-1',
      adminState: 'DISABLING',
    });
    tx.adminGroupOperation.create.mockResolvedValue({
      id: 'operation-1',
      status: 'PENDING',
      type: 'MUTE',
    });

    const result = await service.disableCircle({
      actorId: 'admin-1',
      circleId: 'circle-1',
      reason: '违规内容',
      confirmation: '摄影爱好者',
      idempotencyKey: 'request-1',
    });

    expect(tx.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: expect.objectContaining({
        deleted: true,
        adminState: 'DISABLING',
        adminDisabledBy: 'admin-1',
        adminDisableReason: '违规内容',
      }),
    });
    expect(tx.adminGroupOperation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        groupID: 'group-1',
        circleID: 'circle-1',
        type: 'MUTE',
        idempotencyKey: 'request-1',
      }),
    });
    expect(result.operation.id).toBe('operation-1');
  });

  it('restores a disabled circle only after the queued unmute succeeds', async () => {
    tx.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      name: '摄影爱好者',
      groupID: 'group-1',
      deleted: true,
      adminState: 'DISABLED',
      adminDisabledAt: new Date('2026-07-29T00:00:00.000Z'),
      adminDisabledBy: 'admin-1',
      adminDisableReason: '违规内容',
    });
    tx.circle.update.mockResolvedValue({
      id: 'circle-1',
      deleted: true,
      adminState: 'RESTORING',
    });
    tx.adminGroupOperation.create.mockResolvedValue({
      id: 'operation-2',
      status: 'PENDING',
      type: 'UNMUTE',
    });

    await service.restoreCircle({
      actorId: 'admin-1',
      circleId: 'circle-1',
      reason: '复核通过',
      confirmation: '摄影爱好者',
      idempotencyKey: 'request-2',
    });

    expect(tx.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: { adminState: 'RESTORING' },
    });
  });

  it('does not restore a circle whose group was permanently dismissed', async () => {
    tx.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      name: '摄影爱好者',
      groupID: 'group-1',
      deleted: true,
      adminState: 'DISMISSED',
    });

    await expect(
      service.restoreCircle({
        actorId: 'admin-1',
        circleId: 'circle-1',
        reason: '尝试恢复',
        confirmation: '摄影爱好者',
        idempotencyKey: 'request-2',
      }),
    ).rejects.toThrow('群聊已永久解散，圈子不可恢复');
    expect(tx.adminGroupOperation.create).not.toHaveBeenCalled();
  });

  it('does not restore a legacy deleted circle without admin-disable provenance', async () => {
    tx.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      name: '作者已删除圈子',
      groupID: 'group-1',
      deleted: true,
      adminState: 'ACTIVE',
      adminDisabledAt: null,
      adminDisabledBy: null,
      adminDisableReason: null,
    });

    await expect(
      service.restoreCircle({
        actorId: 'admin-1',
        circleId: 'circle-1',
        reason: '尝试恢复',
        confirmation: '作者已删除圈子',
        idempotencyKey: 'request-legacy',
      }),
    ).rejects.toThrow('圈子不是由管理员停用，无法恢复');
    expect(tx.adminGroupOperation.create).not.toHaveBeenCalled();
    expect(tx.circle.update).not.toHaveBeenCalled();
  });

  it('does not manufacture admin-disable provenance for an already deleted circle', async () => {
    tx.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      name: '作者已删除圈子',
      groupID: 'group-1',
      deleted: true,
      adminState: 'ACTIVE',
      adminDisabledAt: null,
      adminDisabledBy: null,
      adminDisableReason: null,
    });

    await expect(
      service.disableCircle({
        actorId: 'admin-1',
        circleId: 'circle-1',
        reason: '尝试停用',
        confirmation: '作者已删除圈子',
        idempotencyKey: 'request-deleted',
      }),
    ).rejects.toThrow('圈子已经删除，无法停用');
    expect(tx.adminGroupOperation.create).not.toHaveBeenCalled();
    expect(tx.circle.update).not.toHaveBeenCalled();
  });

  it('rejects a circle action when the confirmation does not match', async () => {
    tx.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      name: '摄影爱好者',
      groupID: 'group-1',
      deleted: false,
      adminState: 'ACTIVE',
    });

    await expect(
      service.disableCircle({
        actorId: 'admin-1',
        circleId: 'circle-1',
        reason: '违规内容',
        confirmation: '错误名称',
        idempotencyKey: 'request-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('disables an unlinked circle locally without queuing OpenIM work', async () => {
    tx.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      name: '摄影爱好者',
      groupID: null,
      deleted: false,
      adminState: 'ACTIVE',
    });
    tx.circle.update.mockResolvedValue({
      id: 'circle-1',
      name: '摄影爱好者',
      groupID: null,
      deleted: true,
      adminState: 'DISABLED',
    });

    const result = await service.disableCircle({
      actorId: 'admin-1',
      circleId: 'circle-1',
      reason: '违规内容',
      confirmation: '摄影爱好者',
      idempotencyKey: 'request-1',
    });

    expect(tx.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: expect.objectContaining({
        deleted: true,
        adminState: 'DISABLED',
        adminDisabledBy: 'admin-1',
        adminDisableReason: '违规内容',
      }),
    });
    expect(tx.adminGroupOperation.create).not.toHaveBeenCalled();
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorID: 'admin-1',
        action: 'ADMIN_CIRCLE_STATE_CHANGED',
        entityType: 'Circle',
        entityID: 'circle-1',
        reason: '违规内容',
        requestId: 'request-1',
      }),
    });
    expect(result).toEqual({
      circle: expect.objectContaining({
        id: 'circle-1',
        adminState: 'DISABLED',
      }),
      operation: null,
    });
  });

  it('replays an unlinked circle action without applying it twice', async () => {
    tx.circle.findUnique.mockResolvedValue({
      id: 'circle-1',
      name: '摄影爱好者',
      groupID: null,
      deleted: true,
      adminState: 'DISABLED',
    });
    tx.adminAuditLog.findFirst.mockResolvedValue({
      actorID: 'admin-1',
      action: 'ADMIN_CIRCLE_STATE_CHANGED',
      entityType: 'Circle',
      entityID: 'circle-1',
      reason: '违规内容',
      requestId: 'request-1',
      metadata: { type: 'MUTE' },
    });

    const result = await service.disableCircle({
      actorId: 'admin-1',
      circleId: 'circle-1',
      reason: '违规内容',
      confirmation: '摄影爱好者',
      idempotencyKey: 'request-1',
    });

    expect(tx.circle.update).not.toHaveBeenCalled();
    expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
    expect(result).toEqual({
      circle: expect.objectContaining({ id: 'circle-1' }),
      operation: null,
    });
  });

  it('queues a confirmed standalone group dismissal', async () => {
    tx.adminGroupOperation.create.mockResolvedValue({
      id: 'operation-3',
      status: 'PENDING',
      type: 'DISMISS',
    });

    const result = await service.requestGroupOperation({
      actorId: 'admin-1',
      groupId: 'group-9',
      type: 'DISMISS',
      reason: '诈骗群',
      confirmation: 'group-9',
      idempotencyKey: 'request-3',
    });

    expect(tx.adminGroupOperation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        groupID: 'group-9',
        type: 'DISMISS',
        circleID: null,
      }),
    });
    expect(result.id).toBe('operation-3');
  });

  it('closes a linked circle when its OpenIM group is dismissed', async () => {
    tx.circle.findFirst.mockResolvedValue({
      id: 'circle-9',
      name: '待关闭圈子',
      groupID: 'group-9',
      deleted: false,
      adminState: 'ACTIVE',
    });
    tx.circle.update.mockResolvedValue({
      id: 'circle-9',
      deleted: true,
      adminState: 'DISABLING',
    });
    tx.adminGroupOperation.create.mockResolvedValue({
      id: 'operation-3',
      groupID: 'group-9',
      circleID: 'circle-9',
      status: 'PENDING',
      type: 'DISMISS',
    });

    await service.requestGroupOperation({
      actorId: 'admin-1',
      groupId: 'group-9',
      type: 'DISMISS',
      reason: '群聊违规，永久关闭',
      confirmation: 'group-9',
      idempotencyKey: 'request-3',
    });

    expect(tx.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-9' },
      data: expect.objectContaining({
        deleted: true,
        adminState: 'DISABLING',
        adminDisabledBy: 'admin-1',
        adminDisableReason: '群聊违规，永久关闭',
      }),
    });
    expect(tx.adminGroupOperation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        circleID: 'circle-9',
        type: 'DISMISS',
      }),
    });
  });

  it('returns the original operation when the same request is retried', async () => {
    tx.adminGroupOperation.findUnique.mockResolvedValue({
      id: 'operation-3',
      groupID: 'group-9',
      circleID: null,
      type: 'DISMISS',
      requestedByID: 'admin-1',
      reason: '诈骗群',
      status: 'PENDING',
    });

    const result = await service.requestGroupOperation({
      actorId: 'admin-1',
      groupId: 'group-9',
      type: 'DISMISS',
      reason: '诈骗群',
      confirmation: 'group-9',
      idempotencyKey: 'request-3',
    });

    expect(result.id).toBe('operation-3');
    expect(tx.adminGroupOperation.create).not.toHaveBeenCalled();
  });

  it('rejects an idempotency key reused for a different operation', async () => {
    tx.adminGroupOperation.findUnique.mockResolvedValue({
      id: 'operation-3',
      groupID: 'another-group',
      circleID: null,
      type: 'MUTE',
      requestedByID: 'another-admin',
      reason: '其他请求',
      status: 'PENDING',
    });

    await expect(
      service.requestGroupOperation({
        actorId: 'admin-1',
        groupId: 'group-9',
        type: 'DISMISS',
        reason: '诈骗群',
        confirmation: 'group-9',
        idempotencyKey: 'request-3',
      }),
    ).rejects.toThrow('Idempotency-Key 已用于其他管理操作');
    expect(tx.adminGroupOperation.create).not.toHaveBeenCalled();
  });

  it('merges OpenIM groups with linked circles and pending operations', async () => {
    openim.listGroups.mockResolvedValue({
      total: 1,
      groups: [
        {
          groupInfo: {
            groupID: 'group-1',
            groupName: '摄影爱好者',
            status: 3,
            memberCount: 10,
          },
          groupOwnerUserID: 'owner-1',
          groupOwnerUserName: 'Alice',
        },
      ],
    });
    prisma.circle.findMany.mockResolvedValue([
      { id: 'circle-1', groupID: 'group-1', name: '摄影圈' },
    ]);
    prisma.adminGroupOperation.findMany.mockResolvedValue([
      {
        id: 'operation-1',
        groupID: 'group-1',
        type: 'MUTE',
        status: 'PENDING',
        lastError: null,
      },
    ]);

    const result = await service.listGroups({
      page: 1,
      limit: 20,
      search: '',
    });

    expect(result.items[0]).toMatchObject({
      groupId: 'group-1',
      muted: true,
      linkedCircle: { id: 'circle-1', name: '摄影圈' },
      pendingOperation: { id: 'operation-1', type: 'MUTE' },
    });
  });
});
