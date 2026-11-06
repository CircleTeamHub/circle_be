import { CircleInvitationService } from './circle-invitation.service';

function harness(role = 'ADMIN', status = 'PENDING') {
  const invitation = {
    id: 'request',
    circleID: 'circle',
    applicantID: 'applicant',
    inviterID: 'inviter',
    source: 'INVITE',
    status,
  };
  const bans = new Map<string, unknown>();
  const events: unknown[] = [];
  const tx: any = {
    circleInvitation: {
      findUnique: jest.fn().mockImplementation(() => ({ ...invitation })),
      updateMany: jest.fn().mockImplementation(({ data }: any) => {
        Object.assign(invitation, data);
        return { count: 1 };
      }),
    },
    circleMember: {
      findUnique: jest.fn().mockImplementation(({ where }: any) =>
        where.userID_circleID.userID === 'admin'
          ? { status: 'ACTIVE', role }
          : {
              status: invitation.status === 'APPROVED' ? 'ACTIVE' : 'PENDING',
              role: 'MEMBER',
            },
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    chatConversation: {
      findUnique: jest.fn().mockResolvedValue({ id: 'group' }),
    },
    chatGroupJoinBan: {
      findFirst: jest
        .fn()
        .mockImplementation(() => bans.get('applicant') ?? null),
      upsert: jest.fn().mockImplementation(({ create }: any) => {
        bans.set(create.userID, create);
        return create;
      }),
    },
    chatGroupEvent: {
      create: jest.fn().mockImplementation(({ data }: any) => {
        events.push(data);
        return data;
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((fn: (client: unknown) => unknown) => fn(tx)),
  };
  const realtime = { broadcastCircleInvitationReviewed: jest.fn() };
  const lock = { lock: jest.fn() };
  const service = new CircleInvitationService(
    prisma as never,
    realtime as never,
    {} as never,
    {} as never,
    {} as never,
    lock as never,
    {} as never,
    {} as never,
    {} as never,
  );
  jest
    .spyOn(service as any, 'createAndBroadcastInvitationNotification')
    .mockResolvedValue(undefined);
  return { service: service as any, invitation, bans, events, tx, realtime };
}

describe('circle manager rejection and blacklist', () => {
  it('rejects the request with its audit details', async () => {
    const h = harness();
    await h.service.adminReject('admin', 'request');
    expect(h.invitation.status).toBe('REJECTED');
    expect(h.events).toEqual([
      expect.objectContaining({
        kind: 'admission-reviewed',
        actorID: 'admin',
        targetIDs: ['applicant'],
      }),
    ]);
    expect(h.bans.size).toBe(0);
  });

  it('records the ban in the same transaction as rejecting the request', async () => {
    const h = harness();
    await h.service.adminReject('admin', 'request', true);
    expect(h.invitation.status).toBe('REJECTED');
    expect(h.bans.get('applicant')).toMatchObject({
      conversationID: 'group',
      userID: 'applicant',
      actorID: 'admin',
    });
    expect(h.events).toEqual([
      expect.objectContaining({
        kind: 'member-banned',
        targetIDs: ['applicant'],
      }),
    ]);
  });

  it('does not allow an ordinary member to reject or blacklist applicants', async () => {
    const h = harness('MEMBER');
    await expect(
      h.service.adminReject('admin', 'request', true),
    ).rejects.toMatchObject({
      response: { errorCode: 'INVITATION_OWNER_ADMIN_ONLY' },
    });
    expect(h.invitation.status).toBe('PENDING');
    expect(h.bans.size).toBe(0);
  });

  it('does not remove or blacklist somebody who already joined', async () => {
    const h = harness('ADMIN', 'APPROVED');
    await expect(
      h.service.adminReject('admin', 'request', true),
    ).rejects.toThrow();
    expect(h.bans.size).toBe(0);
    expect(h.tx.circleMember.updateMany).not.toHaveBeenCalled();
  });
});
