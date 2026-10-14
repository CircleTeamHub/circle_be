import { ForbiddenException } from '@nestjs/common';
import { GroupAdmissionService } from './group-admission.service';

// Stateful transaction harness verifies membership rather than only mock calls.
function harness(approval = true) {
  const group: any = {
    id: 'g',
    type: 'GROUP',
    circleID: null,
    ownerID: 'owner',
    name: 'Group',
    avatarUrl: null,
    memberCanInvite: true,
    qrJoinEnabled: true,
    cardJoinEnabled: true,
    joinApprovalRequired: approval,
    clearedBeforeHeight: 4,
  };
  const seats = new Map<string, any>([
    ['owner', { userID: 'owner', role: 'MEMBER', leftAt: null }],
  ]);
  const admissions = new Map<string, any>();
  const deliveries = new Map<string, any>();
  const qr: any = {
    token: 'token',
    issuerID: 'owner',
    targetID: 'g',
    type: 'GROUP',
    expiresAt: new Date(Date.now() + 60000),
    revokedAt: null,
  };
  let serial: Promise<any> = Promise.resolve();
  const tx: any = {
    $queryRaw: jest.fn().mockImplementation(() => [group]),
    $executeRaw: jest.fn(),
    chatConversation: {
      findUnique: jest.fn().mockImplementation(() => group),
      findMany: jest.fn().mockResolvedValue([{ id: 'g' }]),
    },
    chatMember: {
      findUnique: jest
        .fn()
        .mockImplementation(
          ({ where }: any) =>
            seats.get(where.conversationID_userID.userID) ?? null,
        ),
      count: jest
        .fn()
        .mockImplementation(
          () => [...seats.values()].filter((s) => !s.leftAt).length,
        ),
      findMany: jest.fn().mockResolvedValue([{ userID: 'owner' }]),
      upsert: jest.fn().mockImplementation(({ where, create, update }: any) => {
        const id = where.conversationID_userID.userID;
        const seat = seats.has(id) ? { ...seats.get(id), ...update } : create;
        seats.set(id, seat);
        return seat;
      }),
    },
    groupAdmission: {
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        for (const a of admissions.values())
          if (
            a.expiresAt <= new Date() &&
            ['INVITED', 'PENDING'].includes(a.status) &&
            a.applicantID === where.applicantID
          )
            Object.assign(a, data);
      }),
      findFirst: jest
        .fn()
        .mockImplementation(
          ({ where }: any) =>
            [...admissions.values()].find(
              (a) =>
                a.conversationID === where.conversationID &&
                a.applicantID === where.applicantID &&
                (where.status ? where.status.in.includes(a.status) : true),
            ) ?? null,
        ),
      findUnique: jest
        .fn()
        .mockImplementation(
          ({ where }: any) => admissions.get(where.id) ?? null,
        ),
      findUniqueOrThrow: jest
        .fn()
        .mockImplementation(({ where }: any) => admissions.get(where.id)),
      create: jest.fn().mockImplementation(({ data }: any) => {
        const a = {
          id: `a${admissions.size}`,
          createdAt: new Date(),
          acceptedAt: null,
          updatedAt: new Date(),
          reason: '',
          inviterID: null,
          ...data,
        };
        admissions.set(a.id, a);
        return a;
      }),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const a = { ...admissions.get(where.id), ...data };
        admissions.set(a.id, a);
        return a;
      }),
    },
    groupAdmissionDelivery: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockImplementation(({ create }: any) => {
        deliveries.set(
          `${create.admissionID}-${create.recipientID}-${create.event}`,
          create,
        );
        return create;
      }),
    },
    user: {
      count: jest
        .fn()
        .mockImplementation(({ where }: any) => where.id.in.length),
      findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }),
      findMany: jest.fn().mockResolvedValue([
        { id: 'owner', nickname: 'Owner' },
        { id: 'guest', nickname: 'Guest' },
      ]),
    },
    friend: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ userID: 'owner', friendID: 'guest' }]),
    },
    block: { findFirst: jest.fn().mockResolvedValue(null) },
    userPrivacySetting: { findMany: jest.fn().mockResolvedValue([]) },
    notification: { findMany: jest.fn().mockResolvedValue([]) },
    notificationPushOutbox: { updateMany: jest.fn() },
    chatMessage: {
      aggregate: jest.fn().mockResolvedValue({ _max: { height: 10 } }),
    },
    qrToken: { findUnique: jest.fn().mockImplementation(() => qr) },
  };
  const prisma: any = {
    ...tx,
    $transaction: jest.fn().mockImplementation((fn: any) => {
      const task = serial.then(() => fn(tx));
      serial = task.catch(() => {});
      return task;
    }),
  };
  const chat: any = {
    getGroupConversationForMember: jest.fn().mockResolvedValue({ id: 'g' }),
  };
  const broadcast = {
    joinUserToConversation: jest.fn().mockResolvedValue(undefined),
    emitConversationChange: jest.fn(),
  };
  const messages = { insertServerMessage: jest.fn().mockResolvedValue({}) };
  const notifications = {
    deliverGroupAdmissionNotification: jest.fn().mockResolvedValue(undefined),
    markNotificationRead: jest.fn().mockResolvedValue(undefined),
  };
  chat.getOrCreateDirectConversation = jest
    .fn()
    .mockResolvedValue({ id: 'direct' });
  tx.groupAdmissionDelivery.update = jest.fn().mockResolvedValue({});
  tx.groupAdmissionDelivery.updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const service = new GroupAdmissionService(
    prisma,
    chat,
    broadcast as any,
    messages as any,
    notifications as any,
  );
  return {
    service,
    tx,
    seats,
    admissions,
    deliveries,
    group,
    qr,
    broadcast,
    messages,
    notifications,
  };
}

describe('Group admission consent and authorization', () => {
  it('viewing a group does not join or create an application', async () => {
    const h = harness();
    await h.service.preview('guest', 'g');
    expect(h.seats.has('guest')).toBe(false);
    expect(h.admissions.size).toBe(0);
  });
  it('an invitation produces a durable card/notification job but no seat', async () => {
    const h = harness();
    await h.service.invite('owner', 'g', ['guest']);
    expect(h.seats.has('guest')).toBe(false);
    expect([...h.admissions.values()][0].status).toBe('INVITED');
    expect(h.deliveries.size).toBe(1);
  });
  it('deduplicates simultaneous invitations without granting access', async () => {
    const h = harness();
    await Promise.all([
      h.service.invite('owner', 'g', ['guest']),
      h.service.invite('owner', 'g', ['guest']),
    ]);
    expect(h.admissions.size).toBe(1);
    expect(h.deliveries.size).toBe(1);
    expect(h.seats.has('guest')).toBe(false);
  });
  it('a manager cannot approve an invitation before recipient acceptance', async () => {
    const h = harness();
    await h.service.invite('owner', 'g', ['guest']);
    await expect(
      h.service.act('owner', 'a0', 'approve'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.seats.has('guest')).toBe(false);
  });
  it('acceptance with approval required remains pending, then approval creates one seat', async () => {
    const h = harness();
    h.seats.set('member', { userID: 'member', role: 'MEMBER', leftAt: null });
    h.tx.friend.findMany.mockResolvedValue([{ userID: 'member', friendID: 'guest' }]);
    await h.service.invite('member', 'g', ['guest']);
    await h.service.act('guest', 'a0', 'accept');
    expect(h.admissions.get('a0').status).toBe('PENDING');
    expect(h.seats.has('guest')).toBe(false);
    await Promise.all([
      h.service.act('owner', 'a0', 'approve'),
      h.service.act('owner', 'a0', 'approve'),
    ]);
    expect(h.seats.get('guest').clearedBeforeHeight).toBe(10);
    expect(h.tx.chatMember.upsert).toHaveBeenCalledTimes(1);
  });
  it.each(['owner', 'admin'])('a direct invitation from %s joins on acceptance even with approval enabled', async (inviter) => {
    const h = harness();
    if (inviter === 'admin') h.seats.set('admin', { userID: 'admin', role: 'ADMIN', leftAt: null });
    h.tx.friend.findMany.mockResolvedValue([{ userID: inviter, friendID: 'guest' }]);
    await h.service.invite(inviter, 'g', ['guest']);
    expect(h.seats.has('guest')).toBe(false);
    expect((await h.service.detail('guest', 'a0')).requiresApproval).toBe(false);
    await Promise.all([h.service.act('guest', 'a0', 'accept'), h.service.act('guest', 'a0', 'accept')]);
    expect(h.admissions.get('a0').status).toBe('JOINED');
    expect(h.admissions.get('a0').decidedByID).toBe(inviter);
    expect(h.tx.chatMember.upsert).toHaveBeenCalledTimes(1);
    expect([...h.deliveries.values()].some((job) => job.event === 'PENDING')).toBe(false);
  });
  it('a demoted admin invitation returns to review at acceptance', async () => {
    const h = harness();
    h.seats.set('admin', { userID: 'admin', role: 'ADMIN', leftAt: null });
    h.tx.friend.findMany.mockResolvedValue([{ userID: 'admin', friendID: 'guest' }]);
    await h.service.invite('admin', 'g', ['guest']);
    h.seats.get('admin').role = 'MEMBER';
    expect((await h.service.detail('guest', 'a0')).requiresApproval).toBe(true);
    await h.service.act('guest', 'a0', 'accept');
    expect(h.admissions.get('a0').status).toBe('PENDING');
    expect(h.seats.has('guest')).toBe(false);
  });
  it('approving clears reviewer prompts and only queues joined delivery for the applicant', async () => {
    const h = harness();
    await h.service.apply('guest', 'g', '');
    h.tx.groupAdmissionDelivery.findMany.mockResolvedValueOnce([{ id: 'review-job' }]);
    h.tx.notification.findMany.mockResolvedValue([{ id: 'review-job', toUserID: 'owner' }]);
    await h.service.act('owner', 'a0', 'approve');
    expect(h.notifications.markNotificationRead).toHaveBeenCalledWith('owner', 'review-job');
    expect(h.tx.notificationPushOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { notificationID: { in: ['review-job'] }, status: { in: ['PENDING', 'FAILED'] } },
      data: expect.objectContaining({ status: 'TERMINAL' }),
    }));
    expect([...h.deliveries.values()].filter((job) => job.event === 'JOINED').map((job) => job.recipientID)).toEqual(['guest']);
  });
  it('does not replay a completed review prompt or send a joined notice to a manager', async () => {
    const h = harness();
    await h.service.invite('owner', 'g', ['guest']);
    await h.service.act('guest', 'a0', 'accept');
    h.tx.groupAdmissionDelivery.findMany.mockResolvedValue([
      { id: 'old-review', admission: h.admissions.get('a0'), event: 'PENDING', recipientID: 'owner' },
      { id: 'old-joined', admission: h.admissions.get('a0'), event: 'JOINED', recipientID: 'owner' },
    ]);
    await h.service.flush();
    expect(h.notifications.deliverGroupAdmissionNotification).not.toHaveBeenCalled();
  });
  it.each(['invite', 'apply'])('a departed member can rejoin through a new %s without reusing the old seat state', async (flow) => {
    const h = harness();
    await h.service.invite('owner', 'g', ['guest']);
    await h.service.act('guest', 'a0', 'accept');
    h.seats.get('guest').leftAt = new Date();
    expect((await h.service.detail('guest', 'a0')).status).toBe('LEFT');
    expect((await h.service.preview('guest', 'g')).admission?.status).toBe('LEFT');
    h.tx.chatMessage.aggregate.mockResolvedValue({ _max: { height: 30 } });
    if (flow === 'invite') {
      await h.service.invite('owner', 'g', ['guest']);
      expect(h.admissions.get('a1').status).toBe('INVITED');
      expect(h.seats.get('guest').leftAt).not.toBeNull();
      await h.service.act('guest', 'a1', 'accept');
    } else {
      await h.service.apply('guest', 'g', 'rejoin');
      expect(h.admissions.get('a1').status).toBe('PENDING');
      expect(h.seats.get('guest').leftAt).not.toBeNull();
      await h.service.act('owner', 'a1', 'approve');
    }
    expect(h.admissions.get('a1').status).toBe('JOINED');
    expect(h.seats.get('guest').leftAt).toBeNull();
    expect(h.seats.get('guest').clearedBeforeHeight).toBe(30);
    expect(h.seats.get('guest').role).toBe('MEMBER');
  });
  it('a recipient can decline and never gains membership', async () => {
    const h = harness(false);
    await h.service.invite('owner', 'g', ['guest']);
    await h.service.act('guest', 'a0', 'decline');
    expect(h.admissions.get('a0').status).toBe('DECLINED');
    expect(h.seats.has('guest')).toBe(false);
  });
  it('only the invited recipient can accept', async () => {
    const h = harness(false);
    await h.service.invite('owner', 'g', ['guest']);
    await expect(h.service.act('other', 'a0', 'accept')).rejects.toThrow();
    expect(h.seats.has('guest')).toBe(false);
  });
  it('accepting a valid invitation with approval disabled grants access exactly once', async () => {
    const h = harness(false);
    await h.service.invite('owner', 'g', ['guest']);
    await Promise.all([
      h.service.act('guest', 'a0', 'accept'),
      h.service.act('guest', 'a0', 'accept'),
    ]);
    expect(h.tx.chatMember.upsert).toHaveBeenCalledTimes(1);
    expect(h.admissions.get('a0').status).toBe('JOINED');
  });
  it('note-card applications always wait for approval and are deduplicated', async () => {
    const h = harness(false);
    await Promise.all([
      h.service.apply('guest', 'g', 'reason'),
      h.service.apply('guest', 'g', 'reason'),
    ]);
    expect(h.admissions.size).toBe(1);
    expect(h.admissions.get('a0').status).toBe('PENDING');
    expect(h.seats.has('guest')).toBe(false);
    await h.service.act('owner', 'a0', 'reject');
    expect(h.seats.has('guest')).toBe(false);
  });
  it('explicit QR acceptance creates a pending request without a seat', async () => {
    const h = harness();
    const result = await h.service.acceptQr('guest', 'token');
    expect(result).toEqual({
      type: 'GROUP',
      status: 'PENDING',
      admissionId: 'a0',
    });
    expect(h.seats.has('guest')).toBe(false);
  });
  it('explicit QR acceptance may join only when approval is disabled', async () => {
    const h = harness(false);
    const result = await h.service.acceptQr('guest', 'token');
    expect(result.status).toBe('JOINED');
    expect(h.seats.has('guest')).toBe(true);
  });
  it.each([
    'revoked',
    'expired',
    'issuer-left',
    'qr-disabled',
    'invite-disabled',
  ])('rechecks %s before granting QR access', async (reason) => {
    const h = harness(false);
    if (reason === 'revoked') h.qr.revokedAt = new Date();
    if (reason === 'expired') h.qr.expiresAt = new Date(0);
    if (reason === 'issuer-left') h.seats.get('owner').leftAt = new Date();
    if (reason === 'qr-disabled') h.group.qrJoinEnabled = false;
    if (reason === 'invite-disabled') {
      h.group.memberCanInvite = false;
      h.group.ownerID = 'newOwner';
    }
    await expect(h.service.acceptQr('guest', 'token')).rejects.toThrow();
    expect(h.seats.has('guest')).toBe(false);
  });
  it('a manager can reject a pending application even after card applications are disabled', async () => {
    const h = harness();
    await h.service.apply('guest', 'g', '');
    h.group.cardJoinEnabled = false;
    await h.service.act('owner', 'a0', 'reject');
    expect(h.admissions.get('a0').status).toBe('REJECTED');
    expect(h.seats.has('guest')).toBe(false);
  });
  it('rechecks capacity when approving, leaving the request pending', async () => {
    const h = harness();
    await h.service.apply('guest', 'g', '');
    h.tx.chatMember.count.mockResolvedValue(200);
    await expect(h.service.act('owner', 'a0', 'approve')).rejects.toThrow();
    expect(h.admissions.get('a0').status).toBe('PENDING');
    expect(h.seats.has('guest')).toBe(false);
  });
  it('rechecks recipient privacy and inviter membership at acceptance', async () => {
    const h = harness(false);
    await h.service.invite('owner', 'g', ['guest']);
    h.tx.userPrivacySetting.findMany.mockResolvedValue([
      { userID: 'guest', groupInvitePermission: 'NONE' },
    ]);
    await expect(h.service.act('guest', 'a0', 'accept')).rejects.toThrow();
    expect(h.seats.has('guest')).toBe(false);
  });
  it('does not disclose invitation details to a stranger', async () => {
    const h = harness();
    await h.service.invite('owner', 'g', ['guest']);
    await expect(h.service.detail('other', 'a0')).rejects.toThrow();
  });
});

describe('Group admission durable delivery', () => {
  it('notification delivery survives a failed card and retries with stable deduplication keys', async () => {
    const h = harness();
    await h.service.invite('owner', 'g', ['guest']);
    const admission = h.admissions.get('a0');
    const job = {
      id: 'job-1',
      admissionID: admission.id,
      admission,
      recipientID: 'guest',
      actorID: 'owner',
      event: 'INVITED',
      attempts: 0,
    };
    h.tx.groupAdmissionDelivery.findMany.mockResolvedValue([job]);
    h.messages.insertServerMessage.mockRejectedValueOnce(
      new Error('broadcast interrupted'),
    );
    await h.service.flush();
    expect(
      h.notifications.deliverGroupAdmissionNotification,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'job-1',
        toUserID: 'guest',
        admissionId: 'a0',
      }),
    );
    expect(h.tx.groupAdmissionDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attempts: { increment: 1 } }),
      }),
    );
    expect(h.seats.has('guest')).toBe(false);
    await h.service.flush();
    expect(h.messages.insertServerMessage).toHaveBeenNthCalledWith(
      2,
      'direct',
      expect.objectContaining({
        clientMessageId: 'group_invitation_a0',
        rebroadcastOnReplay: true,
      }),
    );
    expect(h.tx.groupAdmissionDelivery.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { deliveredAt: expect.any(Date) } }),
    );
  });
  it('a failed membership broadcast stays queued after membership was committed', async () => {
    const h = harness(false);
    await h.service.invite('owner', 'g', ['guest']);
    await h.service.act('guest', 'a0', 'accept');
    const job = {
      id: 'joined-job',
      admission: h.admissions.get('a0'),
      recipientID: 'guest',
      actorID: 'guest',
      event: 'JOINED',
      attempts: 0,
    };
    h.tx.groupAdmissionDelivery.findMany.mockResolvedValue([job]);
    h.broadcast.joinUserToConversation.mockRejectedValueOnce(
      new Error('adapter offline'),
    );
    await h.service.flush();
    expect(h.seats.has('guest')).toBe(true);
    await h.service.flush();
    expect(h.broadcast.emitConversationChange).toHaveBeenCalledWith(
      'guest',
      expect.objectContaining({ kind: 'joined', conversationId: 'g' }),
    );
    expect(h.tx.chatMember.upsert).toHaveBeenCalledTimes(1);
  });
});
