import { ForbiddenException } from '@nestjs/common';
import { GroupAdmissionService } from './group-admission.service';
import { GROUP_DIRECT_JOIN_MAX_MEMBERS } from './chat-group-roles';
import { jobMetrics } from '../metrics/job-metrics';

async function deliveryRuns(result: string): Promise<number> {
  const text = await jobMetrics.registry.metrics();
  const match = new RegExp(
    `circle_cron_runs_total\\{job="group_admission_delivery",result="${result}"\\} (\\d+)`,
  ).exec(text);
  return match ? Number(match[1]) : 0;
}

// Stateful transaction harness verifies membership rather than only mock calls.
// `crowded` seats filler members so the group already sits at the direct-join
// limit: invitations then take the consent path the older tests exercise.
function harness(approval = true, crowded = true) {
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
  if (crowded)
    for (let i = 1; i < GROUP_DIRECT_JOIN_MAX_MEMBERS; i += 1)
      seats.set(`filler-${i}`, {
        userID: `filler-${i}`,
        role: 'MEMBER',
        leftAt: null,
      });
  const admissions = new Map<string, any>();
  const deliveries = new Map<string, any>();
  const events = new Map<string, any>();
  const bans = new Map<string, any>();
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
    chatGroupJoinBan: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        const ids =
          typeof where.userID === 'string' ? [where.userID] : where.userID.in;
        return ids.map((id: string) => bans.get(id)).find(Boolean) ?? null;
      }),
      upsert: jest.fn().mockImplementation(({ create }: any) => {
        bans.set(create.userID, create);
        return create;
      }),
    },
    $queryRaw: jest.fn().mockImplementation(() => [group]),
    $executeRaw: jest.fn(),
    chatConversation: {
      findUnique: jest.fn().mockImplementation(() => group),
      findMany: jest.fn().mockResolvedValue([{ id: 'g' }]),
    },
    chatMember: {
      groupBy: jest.fn().mockResolvedValue([]),
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
      // 批量邀请按 userID IN 读在座座位;审核人列表(reviewers)照旧只有群主。
      findMany: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          where?.userID?.in
            ? [...seats.values()]
                .filter((s) => where.userID.in.includes(s.userID) && !s.leftAt)
                .map((s) => ({ userID: s.userID }))
            : [{ userID: 'owner' }],
        ),
      upsert: jest.fn().mockImplementation(({ where, create, update }: any) => {
        const id = where.conversationID_userID.userID;
        const seat = seats.has(id) ? { ...seats.get(id), ...update } : create;
        seats.set(id, seat);
        return seat;
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        let count = 0;
        for (const seat of seats.values())
          if (where.userID.in.includes(seat.userID) && seat.leftAt) {
            Object.assign(seat, data);
            count += 1;
          }
        return { count };
      }),
      createMany: jest.fn().mockImplementation(({ data }: any) => {
        for (const row of data)
          if (!seats.has(row.userID))
            seats.set(row.userID, {
              role: 'MEMBER',
              leftAt: null,
              joinedAt: new Date(),
              ...row,
            });
        return { count: data.length };
      }),
    },
    groupAdmission: {
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        for (const a of admissions.values())
          if (
            a.expiresAt <= new Date() &&
            ['INVITED', 'PENDING'].includes(a.status) &&
            (where.applicantID?.in
              ? where.applicantID.in.includes(a.applicantID)
              : a.applicantID === where.applicantID)
          )
            Object.assign(a, data);
      }),
      findMany: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          [...admissions.values()].filter(
            (a) =>
              a.conversationID === where.conversationID &&
              where.applicantID.in.includes(a.applicantID) &&
              where.status.in.includes(a.status),
          ),
        ),
      createManyAndReturn: jest.fn().mockImplementation(({ data }: any) =>
        data.map((row: any) => {
          const a = {
            id: `a${admissions.size}`,
            createdAt: new Date(),
            acceptedAt: null,
            updatedAt: new Date(),
            reason: '',
            inviterID: null,
            ...row,
          };
          admissions.set(a.id, a);
          return { id: a.id, applicantID: a.applicantID, status: a.status };
        }),
      ),
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
      createMany: jest.fn().mockImplementation(({ data }: any) => {
        for (const row of data) {
          const key = `${row.admissionID}-${row.recipientID}-${row.event}`;
          if (!deliveries.has(key)) deliveries.set(key, row);
        }
        return { count: data.length };
      }),
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
    notification: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    notificationPushOutbox: { updateMany: jest.fn() },
    chatMessage: {
      aggregate: jest.fn().mockResolvedValue({ _max: { height: 10 } }),
    },
    chatGroupEvent: {
      create: jest.fn().mockImplementation(({ data }: any) => {
        const event = {
          id: `event-${events.size}`,
          createdAt: new Date(),
          ...data,
        };
        events.set(event.id, event);
        return event;
      }),
    },
    qrToken: { findUnique: jest.fn().mockImplementation(() => qr) },
  };
  const prisma: any = {
    ...tx,
    $transaction: jest.fn().mockImplementation((fn: any) => {
      const task = serial.then(async () => {
        const state = [seats, admissions, deliveries, events, bans];
        const snapshots = state.map((rows) => structuredClone(rows));
        try {
          return await fn(tx);
        } catch (error) {
          state.forEach((rows, i) => {
            rows.clear();
            for (const [id, row] of snapshots[i]) rows.set(id, row);
          });
          throw error;
        }
      });
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
  tx.groupAdmissionDelivery.updateMany = jest
    .fn()
    .mockResolvedValue({ count: 0 });
  const service = new GroupAdmissionService(
    prisma,
    chat,
    broadcast as any,
    messages as any,
    notifications as any,
  );
  return {
    service,
    prisma,
    tx,
    seats,
    admissions,
    deliveries,
    events,
    bans,
    group,
    qr,
    broadcast,
    messages,
    notifications,
  };
}

describe('Group admission consent and authorization', () => {
  it('blacklists an applicant atomically and blocks applications, invitations and QR entry', async () => {
    const h = harness();
    h.tx.friend.findMany.mockResolvedValue([
      { userID: 'owner', friendID: 'candidate' },
    ]);
    const request = (await h.service.apply('candidate', 'g', '')) as {
      id: string;
    };
    await h.service.act('owner', request.id, 'blacklist' as never);
    expect(h.bans.get('candidate')).toMatchObject({
      conversationID: 'g',
      userID: 'candidate',
      actorID: 'owner',
    });
    expect(h.admissions.get(request.id).status).toBe('REJECTED');
    for (const operation of [
      () => h.service.apply('candidate', 'g', ''),
      () => h.service.invite('owner', 'g', ['candidate']),
      () => h.service.acceptQr('candidate', 'token'),
    ])
      await expect(operation()).rejects.toMatchObject({
        response: { errorCode: 'CHAT_GROUP_JOIN_BLOCKED' },
      });
  });

  it('checks the blacklist again before accepting an old invitation', async () => {
    const h = harness(false);
    h.tx.friend.findMany.mockResolvedValue([
      { userID: 'owner', friendID: 'candidate' },
    ]);
    await h.service.invite('owner', 'g', ['candidate']);
    const request = [...h.admissions.values()][0];
    h.bans.set('candidate', {
      conversationID: 'g',
      userID: 'candidate',
      actorID: 'owner',
    });
    await expect(
      h.service.act('candidate', request.id, 'accept'),
    ).rejects.toMatchObject({
      response: { errorCode: 'CHAT_GROUP_JOIN_BLOCKED' },
    });
    expect(h.seats.has('candidate')).toBe(false);
  });

  it('does not blacklist or remove an already joined member through a stale application', async () => {
    const h = harness(false);
    h.tx.friend.findMany.mockResolvedValue([
      { userID: 'owner', friendID: 'candidate' },
    ]);
    await h.service.invite('owner', 'g', ['candidate']);
    const request = [...h.admissions.values()][0];
    await h.service.act('candidate', request.id, 'accept');
    await expect(
      h.service.act('owner', request.id, 'blacklist' as never),
    ).rejects.toThrow();
    expect(h.bans.size).toBe(0);
    expect(h.seats.get('candidate').leftAt).toBeFalsy();
  });
  it('includes decided admissions in a scoped manager history while keeping the inbox pending-only', async () => {
    const h = harness();
    h.tx.groupAdmission.findMany.mockResolvedValue([]);
    await h.service.list('owner', undefined, 'g');
    const scoped = h.tx.groupAdmission.findMany.mock.calls[0][0].where;
    expect(scoped.conversationID).toBe('g');
    expect(scoped.OR[2]).toEqual({ conversationID: { in: ['g'] } });
    await h.service.list('owner');
    const inbox = h.tx.groupAdmission.findMany.mock.calls[1][0].where;
    expect(inbox.OR[2]).toEqual({
      conversationID: { in: ['g'] },
      status: 'PENDING',
    });
  });
  it('does not grant a scoped non-manager access to other applicants history', async () => {
    const h = harness();
    h.tx.chatConversation.findMany.mockResolvedValue([]);
    h.tx.groupAdmission.findMany.mockResolvedValue([]);
    await h.service.list('guest', undefined, 'g');
    expect(h.tx.groupAdmission.findMany.mock.calls[0][0].where).toMatchObject({
      conversationID: 'g',
      OR: [
        { applicantID: 'guest' },
        { inviterID: 'guest' },
        { conversationID: { in: [] } },
      ],
    });
  });
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
    h.tx.friend.findMany.mockResolvedValue([
      { userID: 'member', friendID: 'guest' },
    ]);
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
  it.each(['owner', 'admin'])(
    'a direct invitation from %s joins on acceptance even with approval enabled',
    async (inviter) => {
      const h = harness();
      if (inviter === 'admin')
        h.seats.set('admin', { userID: 'admin', role: 'ADMIN', leftAt: null });
      h.tx.friend.findMany.mockResolvedValue([
        { userID: inviter, friendID: 'guest' },
      ]);
      await h.service.invite(inviter, 'g', ['guest']);
      expect(h.seats.has('guest')).toBe(false);
      expect((await h.service.detail('guest', 'a0')).requiresApproval).toBe(
        false,
      );
      await Promise.all([
        h.service.act('guest', 'a0', 'accept'),
        h.service.act('guest', 'a0', 'accept'),
      ]);
      expect(h.admissions.get('a0').status).toBe('JOINED');
      expect(h.admissions.get('a0').decidedByID).toBe(inviter);
      expect(h.tx.chatMember.upsert).toHaveBeenCalledTimes(1);
      expect(
        [...h.deliveries.values()].some((job) => job.event === 'PENDING'),
      ).toBe(false);
    },
  );
  it('records an approved invitation join once and attributes the original inviter', async () => {
    const h = harness();
    h.seats.set('member', { userID: 'member', role: 'MEMBER', leftAt: null });
    h.tx.friend.findMany.mockResolvedValue([
      { userID: 'member', friendID: 'guest' },
    ]);
    await h.service.invite('member', 'g', ['guest']);
    await h.service.act('guest', 'a0', 'accept');
    expect(h.events.size).toBe(0);
    await Promise.all([
      h.service.act('owner', 'a0', 'approve'),
      h.service.act('owner', 'a0', 'approve'),
    ]);
    expect([...h.events.values()]).toEqual([
      expect.objectContaining({
        conversationID: 'g',
        kind: 'member-joined',
        actorID: 'member',
        targetIDs: ['guest'],
        payload: {
          via: 'invite',
          status: 'JOINED',
          source: 'INVITE',
          inviterId: 'member',
          operatorId: 'owner',
        },
        createdAt: expect.any(Date),
      }),
    ]);
  });
  it('records QR membership with its join method and no invented inviter', async () => {
    const h = harness(false);
    await h.service.acceptQr('guest', 'token');
    expect([...h.events.values()]).toEqual([
      expect.objectContaining({
        conversationID: 'g',
        kind: 'member-joined',
        actorID: null,
        targetIDs: ['guest'],
        payload: {
          via: 'qr',
          status: 'JOINED',
          source: 'QR',
          inviterId: 'owner',
          operatorId: 'guest',
        },
      }),
    ]);
  });
  it('rolls back acceptance and membership if writing the join ledger fails', async () => {
    const h = harness(false);
    await h.service.invite('owner', 'g', ['guest']);
    h.tx.chatGroupEvent.create.mockRejectedValueOnce(
      new Error('ledger unavailable'),
    );
    await expect(h.service.act('guest', 'a0', 'accept')).rejects.toThrow(
      'ledger unavailable',
    );
    expect(h.seats.has('guest')).toBe(false);
    expect(h.admissions.get('a0')).toMatchObject({
      status: 'INVITED',
      acceptedAt: null,
    });
    expect(
      [...h.deliveries.values()].some((job) => job.event === 'JOINED'),
    ).toBe(false);
    expect(h.events.size).toBe(0);
  });
  it('a demoted admin invitation returns to review at acceptance', async () => {
    const h = harness();
    h.seats.set('admin', { userID: 'admin', role: 'ADMIN', leftAt: null });
    h.tx.friend.findMany.mockResolvedValue([
      { userID: 'admin', friendID: 'guest' },
    ]);
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
    h.tx.groupAdmissionDelivery.findMany.mockResolvedValueOnce([
      { id: 'review-job' },
    ]);
    h.tx.notification.findMany.mockResolvedValue([
      { id: 'review-job', toUserID: 'owner' },
    ]);
    await h.service.act('owner', 'a0', 'approve');
    expect(h.notifications.markNotificationRead).toHaveBeenCalledWith(
      'owner',
      'review-job',
    );
    expect(h.tx.notificationPushOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          notificationID: { in: ['review-job'] },
          status: { in: ['PENDING', 'FAILED'] },
        },
        data: expect.objectContaining({ status: 'TERMINAL' }),
      }),
    );
    expect(
      [...h.deliveries.values()]
        .filter((job) => job.event === 'JOINED')
        .map((job) => job.recipientID),
    ).toEqual(['guest']);
  });
  it('does not replay a completed review prompt or send a joined notice to a manager', async () => {
    const h = harness();
    await h.service.invite('owner', 'g', ['guest']);
    await h.service.act('guest', 'a0', 'accept');
    h.tx.groupAdmissionDelivery.findMany.mockResolvedValue([
      {
        id: 'old-review',
        admission: h.admissions.get('a0'),
        event: 'PENDING',
        recipientID: 'owner',
      },
      {
        id: 'old-joined',
        admission: h.admissions.get('a0'),
        event: 'JOINED',
        recipientID: 'owner',
      },
    ]);
    await h.service.flush();
    expect(
      h.notifications.deliverGroupAdmissionNotification,
    ).not.toHaveBeenCalled();
  });
  it.each(['invite', 'apply'])(
    'a departed member can rejoin through a new %s without reusing the old seat state',
    async (flow) => {
      const h = harness();
      await h.service.invite('owner', 'g', ['guest']);
      await h.service.act('guest', 'a0', 'accept');
      h.seats.get('guest').leftAt = new Date();
      expect((await h.service.detail('guest', 'a0')).status).toBe('LEFT');
      expect((await h.service.preview('guest', 'g')).admission?.status).toBe(
        'LEFT',
      );
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
    },
  );
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

describe('Group admission small-group direct join', () => {
  const befriend = (
    h: ReturnType<typeof harness>,
    inviter: string,
    ids: string[],
  ) =>
    h.tx.friend.findMany.mockResolvedValue(
      ids.map((friendID) => ({ userID: inviter, friendID })),
    );
  const statuses = (h: ReturnType<typeof harness>) =>
    [...h.admissions.values()].map((a) => [a.applicantID, a.status]);
  const jobs = (h: ReturnType<typeof harness>) =>
    [...h.deliveries.values()].map((job) => [job.recipientID, job.event]);

  it('seats invited friends without a consent step while the group stays within the limit', async () => {
    const h = harness(true, false);
    befriend(h, 'owner', ['guest', 'friend']);
    await h.service.invite('owner', 'g', ['guest', 'friend']);
    for (const id of ['guest', 'friend'])
      expect(h.seats.get(id)).toMatchObject({
        leftAt: null,
        role: 'MEMBER',
        clearedBeforeHeight: 10,
      });
    expect([...h.admissions.values()]).toEqual(
      ['guest', 'friend'].map((applicantID) =>
        expect.objectContaining({
          applicantID,
          inviterID: 'owner',
          status: 'JOINED',
          acceptedAt: expect.any(Date),
          decidedByID: 'owner',
        }),
      ),
    );
    expect(jobs(h)).toEqual([
      ['guest', 'JOINED'],
      ['friend', 'JOINED'],
    ]);
    expect([...h.events.values()]).toEqual([
      expect.objectContaining({
        conversationID: 'g',
        kind: 'member-joined',
        actorID: 'owner',
        targetIDs: ['guest', 'friend'],
        payload: {
          via: 'invite',
          status: 'JOINED',
          source: 'INVITE',
          inviterId: 'owner',
          operatorId: 'owner',
        },
      }),
    ]);
  });

  it('fills the group up to the limit in selection order and invites everyone past it', async () => {
    const h = harness(false, false);
    // Owner plus 27 members: two seats remain below the limit.
    for (let i = 1; i <= GROUP_DIRECT_JOIN_MAX_MEMBERS - 3; i += 1)
      h.seats.set(`m${i}`, { userID: `m${i}`, role: 'MEMBER', leftAt: null });
    befriend(h, 'owner', ['a', 'b', 'c', 'd', 'e']);
    await h.service.invite('owner', 'g', ['c', 'a', 'd', 'b']);
    expect(statuses(h)).toEqual([
      ['c', 'JOINED'],
      ['a', 'JOINED'],
      ['d', 'INVITED'],
      ['b', 'INVITED'],
    ]);
    expect(jobs(h)).toEqual([
      ['c', 'JOINED'],
      ['a', 'JOINED'],
      ['d', 'INVITED'],
      ['b', 'INVITED'],
    ]);
    expect(['c', 'a'].every((id) => h.seats.has(id))).toBe(true);
    expect(['d', 'b'].some((id) => h.seats.has(id))).toBe(false);
    // The group now holds exactly the limit, so the next invitee must accept.
    await h.service.invite('owner', 'g', ['e']);
    expect(h.admissions.get('a4').status).toBe('INVITED');
    expect(h.seats.has('e')).toBe(false);
  });

  it('skips consent for a regular member invitation but keeps manager review', async () => {
    const h = harness(true, false);
    h.seats.set('member', { userID: 'member', role: 'MEMBER', leftAt: null });
    befriend(h, 'member', ['guest']);
    await h.service.invite('member', 'g', ['guest']);
    expect(h.seats.has('guest')).toBe(false);
    expect(h.admissions.get('a0')).toMatchObject({
      status: 'PENDING',
      inviterID: 'member',
      acceptedAt: expect.any(Date),
    });
    // Reviewers get the join request on the applicant's behalf; no invitation card.
    expect([...h.deliveries.values()]).toEqual([
      expect.objectContaining({
        admissionID: 'a0',
        recipientID: 'owner',
        actorID: 'guest',
        event: 'PENDING',
      }),
    ]);
    await h.service.act('owner', 'a0', 'approve');
    expect(h.admissions.get('a0').status).toBe('JOINED');
    expect(h.seats.has('guest')).toBe(true);
  });

  it('sends only the invitees within the limit to review and invites the rest', async () => {
    const h = harness(true, false);
    h.seats.set('member', { userID: 'member', role: 'MEMBER', leftAt: null });
    // Owner, member and 27 more: one seat remains below the limit.
    for (let i = 1; i <= GROUP_DIRECT_JOIN_MAX_MEMBERS - 3; i += 1)
      h.seats.set(`m${i}`, { userID: `m${i}`, role: 'MEMBER', leftAt: null });
    befriend(h, 'member', ['x', 'y']);
    await h.service.invite('member', 'g', ['x', 'y']);
    expect(statuses(h)).toEqual([
      ['x', 'PENDING'],
      ['y', 'INVITED'],
    ]);
    expect(jobs(h)).toEqual([
      ['owner', 'PENDING'],
      ['y', 'INVITED'],
    ]);
    expect(['x', 'y'].some((id) => h.seats.has(id))).toBe(false);
  });

  it('re-seats a departed member with a fresh role and history floor', async () => {
    const h = harness(false, false);
    h.seats.set('guest', {
      userID: 'guest',
      role: 'ADMIN',
      leftAt: new Date(0),
      hiddenAt: new Date(0),
      clearedBeforeHeight: 1,
    });
    befriend(h, 'owner', ['guest']);
    await h.service.invite('owner', 'g', ['guest']);
    expect(h.seats.get('guest')).toMatchObject({
      leftAt: null,
      role: 'MEMBER',
      hiddenAt: null,
      clearedBeforeHeight: 10,
    });
    expect(h.admissions.get('a0').status).toBe('JOINED');
  });

  it('still refuses a friend who disabled group invitations, seating nobody', async () => {
    const h = harness(false, false);
    befriend(h, 'owner', ['guest', 'friend']);
    h.tx.userPrivacySetting.findMany.mockResolvedValue([
      { userID: 'friend', groupInvitePermission: 'NONE' },
    ]);
    await expect(
      h.service.invite('owner', 'g', ['guest', 'friend']),
    ).rejects.toMatchObject({
      response: { errorCode: 'GROUP_INVITE_NOT_ALLOWED' },
    });
    expect(h.seats.has('guest')).toBe(false);
    expect(h.admissions.size).toBe(0);
  });

  it('delivers a direct join so the new member enters the room', async () => {
    const h = harness(false, false);
    befriend(h, 'owner', ['guest']);
    await h.service.invite('owner', 'g', ['guest']);
    h.tx.groupAdmissionDelivery.findMany.mockResolvedValue([
      {
        id: 'joined-job',
        admission: h.admissions.get('a0'),
        recipientID: 'guest',
        actorID: 'owner',
        event: 'JOINED',
        attempts: 0,
      },
    ]);
    await h.service.flush();
    expect(h.broadcast.joinUserToConversation).toHaveBeenCalledWith(
      'guest',
      'g',
    );
    expect(
      h.notifications.deliverGroupAdmissionNotification,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        toUserID: 'guest',
        content: '已加入「Group」',
      }),
    );
    expect(h.messages.insertServerMessage).not.toHaveBeenCalled();
  });
});

describe('Group admission durable delivery', () => {
  it('does not deliver queued invitation cards after the owner seat was dissolved', async () => {
    const h = harness();
    await h.service.invite('owner', 'g', ['guest']);
    h.seats.get('owner').leftAt = new Date();
    h.tx.groupAdmissionDelivery.findMany.mockResolvedValue([
      {
        id: 'stale',
        admission: h.admissions.get('a0'),
        recipientID: 'guest',
        actorID: 'owner',
        event: 'INVITED',
        attempts: 1,
      },
    ]);
    await h.service.flush();
    expect(
      h.notifications.deliverGroupAdmissionNotification,
    ).not.toHaveBeenCalled();
    expect(h.messages.insertServerMessage).not.toHaveBeenCalled();
    expect(h.tx.groupAdmissionDelivery.update).toHaveBeenCalledWith({
      where: { id: 'stale' },
      data: { deliveredAt: expect.any(Date) },
    });
  });

  it('stops selecting a permanently failed card at the retry limit', async () => {
    const h = harness();
    await h.service.invite('owner', 'g', ['guest']);
    const job = {
      id: 'failed',
      admission: h.admissions.get('a0'),
      recipientID: 'guest',
      actorID: 'owner',
      event: 'INVITED',
      attempts: 7,
    };
    h.tx.groupAdmissionDelivery.findMany.mockImplementation(
      async ({ where }: any) => (job.attempts < where.attempts.lt ? [job] : []),
    );
    h.tx.groupAdmissionDelivery.update.mockImplementation(
      async ({ data }: any) => {
        if (data.attempts) job.attempts += data.attempts.increment;
        return job;
      },
    );
    h.messages.insertServerMessage.mockRejectedValue(
      new Error('permanent failure'),
    );
    await h.service.flush();
    await h.service.flush();
    expect(job.attempts).toBe(8);
    expect(h.messages.insertServerMessage).toHaveBeenCalledTimes(1);
  });

  // flush 由 @TrackedInterval 包装：吞掉单条投递失败后正常返回的那一轮必须记成
  // failure，否则一直投递失败时心跳照常前进，CronJobFailing 永远打不中。
  it('records a run whose delivery failed as a failed run, not a success', async () => {
    const h = harness();
    await h.service.invite('owner', 'g', ['guest']);
    const job = {
      id: 'failing',
      admission: h.admissions.get('a0'),
      recipientID: 'guest',
      actorID: 'owner',
      event: 'INVITED',
      attempts: 0,
    };
    h.tx.groupAdmissionDelivery.findMany.mockResolvedValue([job]);
    h.tx.groupAdmissionDelivery.update.mockResolvedValue(job);
    h.messages.insertServerMessage.mockRejectedValue(new Error('transient'));
    const before = await deliveryRuns('failure');

    await h.service.flush();

    expect(await deliveryRuns('failure')).toBe(before + 1);
  });

  it('records an overlapping flush as skipped so a stuck run cannot refresh the heartbeat', async () => {
    const h = harness();
    let release = (_jobs: unknown[]) => {};
    h.tx.groupAdmissionDelivery.findMany.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const before = await deliveryRuns('skipped');

    const stuck = h.service.flush();
    await h.service.flush();
    expect(await deliveryRuns('skipped')).toBe(before + 1);

    release([]);
    await stuck;
  });

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

test('cannot apply after the final owner has left the group', async () => {
  const h = harness();
  h.seats.get('owner').leftAt = new Date();
  await expect(h.service.apply('guest', 'g', '')).rejects.toThrow();
  expect(h.admissions.size).toBe(0);
});

test('a blocked global delivery job cannot delay a committed invitation response', async () => {
  const h = harness();
  const delivery = jest
    .spyOn(h.service, 'flush')
    .mockReturnValue(new Promise(() => {}));
  await expect(h.service.invite('owner', 'g', ['guest'])).resolves.toEqual({
    id: 'g',
  });
  expect(h.admissions.size).toBe(1);
  delivery.mockRestore();
});

test('dissolved group previews are unavailable even while ownerID remains stored', async () => {
  const h = harness();
  h.seats.get('owner').leftAt = new Date();
  await expect(h.service.preview('guest', 'g')).rejects.toThrow();
});

test.each(['accept', 'decline'] as const)(
  'resolved %s invitations are not delivered as fresh invitations',
  async (action) => {
    const h = harness();
    await h.service.invite('owner', 'g', ['guest']);
    await h.service.act('guest', 'a0', action);
    h.notifications.deliverGroupAdmissionNotification.mockClear();
    h.messages.insertServerMessage.mockClear();
    h.tx.groupAdmissionDelivery.findMany.mockResolvedValue([
      {
        id: 'old-invite',
        admission: { ...h.admissions.get('a0'), status: 'INVITED' },
        recipientID: 'guest',
        actorID: 'owner',
        event: 'INVITED',
        attempts: 0,
      },
    ]);
    await h.service.flush();
    expect(h.messages.insertServerMessage).not.toHaveBeenCalled();
    expect(
      h.notifications.deliverGroupAdmissionNotification,
    ).not.toHaveBeenCalled();
  },
);

test('notification failure does not block the admitted member joining the room', async () => {
  const h = harness(false);
  await h.service.invite('owner', 'g', ['guest']);
  await h.service.act('guest', 'a0', 'accept');
  const admission = h.admissions.get('a0');
  h.tx.groupAdmissionDelivery.findMany.mockResolvedValue([
    {
      id: 'join',
      admission,
      recipientID: 'guest',
      actorID: 'guest',
      event: 'JOINED',
      attempts: 0,
    },
  ]);
  h.notifications.deliverGroupAdmissionNotification.mockRejectedValue(
    new Error('notification failure'),
  );
  await h.service.flush();
  expect(h.broadcast.joinUserToConversation).toHaveBeenCalledWith('guest', 'g');
  expect(h.broadcast.emitConversationChange).toHaveBeenCalled();
});

test.each(['left', 'demoted'])(
  'pending reviewer notifications are dropped when the reviewer was %s',
  async (state) => {
    const h = harness();
    h.seats.set('reviewer', {
      userID: 'reviewer',
      role: 'ADMIN',
      leftAt: null,
    });
    await h.service.apply('guest', 'g', 'Please join');
    h.seats.set('reviewer', {
      userID: 'reviewer',
      role: 'MEMBER',
      leftAt: state === 'left' ? new Date() : null,
    });
    h.tx.groupAdmissionDelivery.findMany.mockResolvedValue([
      {
        id: 'review',
        admission: h.admissions.get('a0'),
        recipientID: 'reviewer',
        actorID: 'guest',
        event: 'PENDING',
        attempts: 0,
      },
    ]);
    h.notifications.deliverGroupAdmissionNotification.mockClear();
    await h.service.flush();
    expect(
      h.notifications.deliverGroupAdmissionNotification,
    ).not.toHaveBeenCalled();
  },
);

test.each(['left', 'unfriended', 'blocked', 'privacy', 'policy'])(
  'queued group invitations are terminalized when eligibility changes: %s',
  async (condition) => {
    const h = harness();
    h.seats.set('inviter', { userID: 'inviter', role: 'MEMBER', leftAt: null });
    h.tx.friend.findMany.mockResolvedValue([
      { userID: 'inviter', friendID: 'guest' },
    ]);
    await h.service.invite('inviter', 'g', ['guest']);
    if (condition === 'left') h.seats.get('inviter').leftAt = new Date();
    if (condition === 'unfriended') h.tx.friend.findMany.mockResolvedValue([]);
    if (condition === 'blocked')
      h.tx.block.findFirst.mockResolvedValue({ id: 'block' });
    if (condition === 'privacy')
      h.tx.userPrivacySetting.findMany.mockResolvedValue([
        { userID: 'guest', groupInvitePermission: 'NONE' },
      ]);
    if (condition === 'policy') h.group.memberCanInvite = false;
    h.tx.groupAdmissionDelivery.findMany.mockResolvedValue([
      {
        id: 'queued',
        admission: h.admissions.get('a0'),
        recipientID: 'guest',
        actorID: 'inviter',
        event: 'INVITED',
        attempts: 0,
      },
    ]);
    await h.service.flush();
    expect(
      h.notifications.deliverGroupAdmissionNotification,
    ).not.toHaveBeenCalled();
    expect(h.messages.insertServerMessage).not.toHaveBeenCalled();
    expect(h.tx.groupAdmissionDelivery.update).toHaveBeenCalledWith({
      where: { id: 'queued' },
      data: { deliveredAt: expect.any(Date) },
    });
  },
);

test('reviewer delivery holds the group mutation lock through authorization and dispatch', async () => {
  const h = harness();
  await h.service.apply('guest', 'g', 'reason');
  h.seats.set('reviewer', { userID: 'reviewer', role: 'ADMIN', leftAt: null });
  h.tx.groupAdmissionDelivery.findMany.mockResolvedValue([
    {
      id: 'review',
      admission: h.admissions.get('a0'),
      recipientID: 'reviewer',
      actorID: 'guest',
      event: 'PENDING',
      attempts: 0,
    },
  ]);
  let checked!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>((resolve) => {
    checked = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const original = h.tx.chatMember.findUnique.getMockImplementation();
  h.tx.chatMember.findUnique.mockImplementation(async (args: any) => {
    const seat = original(args);
    if (args.where.conversationID_userID.userID === 'reviewer') {
      checked();
      await barrier;
    }
    return seat;
  });
  const delivery = h.service.flush();
  await reached;
  let demoted = false;
  const demotion = h.prisma.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT id FROM "ChatConversation" FOR UPDATE`;
    h.seats.get('reviewer').role = 'MEMBER';
    demoted = true;
  });
  h.notifications.deliverGroupAdmissionNotification.mockImplementation(
    async () => {
      expect(demoted).toBe(false);
    },
  );
  await Promise.resolve();
  expect(demoted).toBe(false);
  resume();
  await Promise.all([delivery, demotion]);
  expect(demoted).toBe(true);
  expect(
    h.notifications.deliverGroupAdmissionNotification,
  ).toHaveBeenCalledTimes(1);
  h.notifications.deliverGroupAdmissionNotification.mockClear();
  await h.service.flush();
  expect(
    h.notifications.deliverGroupAdmissionNotification,
  ).not.toHaveBeenCalled();
});
