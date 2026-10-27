import { NotificationService } from './notification.service';
it('replaying an admission delivery creates one unread notification and one push outbox entry', async () => {
  const rows = new Map<string, any>();
  const pushes = new Set<string>();
  const tx: any = {
    notification: {
      upsert: jest.fn().mockImplementation(({ where, create }: any) => {
        if (!rows.has(where.id))
          rows.set(where.id, {
            ...create,
            read: false,
            createdAt: new Date(),
          });
        return rows.get(where.id);
      }),
    },
    notificationPushOutbox: {
      upsert: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          pushes.add(where.notificationID),
        ),
    },
  };
  // 关系在事务提交之后才读：只查到入群申请这一张关系表（发送者行已不在也照样出 null）。
  const prisma: any = {
    $transaction: async (callback: any) => callback(tx),
    user: { findMany: jest.fn().mockResolvedValue([]) },
    groupAdmission: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'admission', status: 'INVITED' }]),
    },
  };
  const realtime: any = {
    broadcastNotificationCreated: jest.fn(),
    broadcastInteractionUnread: jest.fn().mockResolvedValue(undefined),
  };
  const service = new NotificationService(prisma, realtime);
  const input = {
    id: 'delivery-id',
    admissionId: 'admission',
    toUserID: 'guest',
    fromUserID: 'owner',
    content: 'invitation',
  };
  await service.deliverGroupAdmissionNotification(input);
  await service.deliverGroupAdmissionNotification(input);
  expect(rows.size).toBe(1);
  expect(pushes.size).toBe(1);
  expect(rows.get('delivery-id').read).toBe(false);
  expect(realtime.broadcastNotificationCreated).toHaveBeenLastCalledWith(
    'guest',
    expect.objectContaining({
      fromUser: null,
      fromGroupAdmission: { id: 'admission', status: 'INVITED' },
    }),
  );
  expect(tx.notification.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      select: expect.objectContaining({ fromGroupAdmissionID: true }),
    }),
  );
  expect(tx.notification.upsert.mock.calls[0][0]).not.toHaveProperty('include');
});
