import { NotificationPushOutboxProcessor } from './notification-push-outbox.processor';

const notification = {
  id: 'notification-1',
  type: 'SYSTEM',
  content: 'hello',
  read: false,
  createdAt: new Date('2026-07-11T00:00:00.000Z'),
  toUserID: 'user-1',
  fromUser: null,
  fromTrace: null,
  fromReply: null,
  fromCircle: null,
  fromCirclePost: null,
  fromInvitation: null,
  fromFriendRequest: null,
};

describe('NotificationPushOutboxProcessor leases', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the actual claim time for each job in a long batch', async () => {
    jest.useFakeTimers().setSystemTime(Date.parse('2026-07-11T00:00:00.000Z'));
    const prisma = {
      notificationPushOutbox: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'job-1', status: 'PENDING', attempts: 0, notification },
          { id: 'job-2', status: 'PENDING', attempts: 0, notification },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
    };
    const push = {
      sendNotification: jest
        .fn()
        .mockImplementationOnce(async () => {
          jest.setSystemTime(Date.parse('2026-07-11T00:11:00.000Z'));
          return { status: 'DELIVERED' };
        })
        .mockResolvedValueOnce({ status: 'DELIVERED' }),
    };
    const processor = new NotificationPushOutboxProcessor(
      prisma as any,
      push as any,
    );

    await processor.processPending();

    const claims = prisma.notificationPushOutbox.updateMany.mock.calls
      .map(([input]) => input)
      .filter((input) => input.data.status === 'PROCESSING');
    expect(claims).toHaveLength(2);
    expect(claims[0].data.lockedAt).toEqual(
      new Date('2026-07-11T00:00:00.000Z'),
    );
    expect(claims[1].data.lockedAt).toEqual(
      new Date('2026-07-11T00:11:00.000Z'),
    );
    expect(claims[0].data.leaseToken).toEqual(expect.any(String));
    expect(claims[1].data.leaseToken).toEqual(expect.any(String));
  });

  it('requires the active lease when completing a job', async () => {
    const prisma = {
      notificationPushOutbox: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'job-1', status: 'PENDING', attempts: 0, notification },
          ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
    };
    const processor = new NotificationPushOutboxProcessor(
      prisma as any,
      {
        sendNotification: jest.fn().mockResolvedValue({ status: 'DELIVERED' }),
      } as any,
    );

    await processor.processPending();

    const writes = prisma.notificationPushOutbox.updateMany.mock.calls.map(
      ([input]) => input,
    );
    const leaseToken = writes[0].data.leaseToken;
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: {
            id: 'job-1',
            leaseToken,
            status: 'PROCESSING',
          },
          data: expect.objectContaining({
            status: 'COMPLETED',
            leaseToken: null,
          }),
        }),
      ]),
    );
    expect(prisma.notificationPushOutbox.update).not.toHaveBeenCalled();
  });

  it('records non-retryable ticket failures as terminal', async () => {
    const prisma = {
      notificationPushOutbox: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'job-1', status: 'PENDING', attempts: 0, notification },
          ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
    };
    const processor = new NotificationPushOutboxProcessor(
      prisma as any,
      {
        sendNotification: jest.fn().mockResolvedValue({
          status: 'TERMINAL_FAILURE',
          error: 'MessageTooBig',
        }),
      } as any,
    );

    await processor.processPending();

    const writes = prisma.notificationPushOutbox.updateMany.mock.calls.map(
      ([input]) => input,
    );
    const leaseToken = writes[0].data.leaseToken;
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: { id: 'job-1', leaseToken, status: 'PROCESSING' },
          data: expect.objectContaining({
            status: 'TERMINAL',
            lastError: 'MessageTooBig',
            leaseToken: null,
          }),
        }),
      ]),
    );
  });
});
