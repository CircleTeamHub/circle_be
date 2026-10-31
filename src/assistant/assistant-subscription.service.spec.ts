import { AssistantSubscriptionService } from './assistant-subscription.service';

// 默认每个订阅人都还在圈内:按查询条件原样回显 (circleID, userID) 组合。
function activeMembersOf(args: {
  where: { circleID: { in: string[] }; userID: { in: string[] } };
}) {
  return Promise.resolve(
    args.where.circleID.in.flatMap((circleID) =>
      args.where.userID.in.map((userID) => ({ circleID, userID })),
    ),
  );
}

describe('AssistantSubscriptionService', () => {
  it('matches a post against the current circle cities and skips other cities', async () => {
    const tx = {
      circlePost: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'post-1',
          content: '北京周末活动',
          tags: [],
          city: '北京',
          cities: ['北京'],
          authorID: 'author-1',
          createdAt: new Date('2026-10-30T10:00:00.000Z'),
          circleLinks: [{ circleID: 'circle-1' }],
        }),
      },
      assistantSubscription: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'sub-beijing',
            userID: 'user-beijing',
            circleID: 'circle-1',
            cities: [],
            keywords: [],
            sourceTypes: ['PLAZA_POST'],
            circle: { id: 'circle-1', name: '北京生活圈', cities: ['北京'] },
          },
          {
            id: 'sub-shanghai',
            userID: 'user-shanghai',
            circleID: 'circle-1',
            cities: [],
            keywords: [],
            sourceTypes: ['PLAZA_POST'],
            circle: { id: 'circle-1', name: '上海生活圈', cities: ['上海'] },
          },
        ]),
      },
      circleMember: {
        findMany: jest.fn().mockImplementation(activeMembersOf),
      },
      assistantAlertDelivery: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new AssistantSubscriptionService({} as never);

    const count = await service.enqueueCirclePost(
      tx as never,
      'post-1',
      'author-1',
      ['circle-1'],
    );

    expect(count).toBe(1);
    expect(tx.assistantAlertDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [
          expect.objectContaining({
            userID: 'user-beijing',
            sourceID: 'post-1',
            dedupeKey: 'windnote-assistant:info:user-beijing:post-1:1',
            subscriptionIDs: ['sub-beijing'],
          }),
        ],
      }),
    );
  });

  it('treats an empty circle city list as an unrestricted city scope', async () => {
    const tx = {
      circlePost: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'post-2',
          content: '全国信息',
          tags: [],
          city: null,
          cities: [],
          authorID: 'author-1',
          createdAt: new Date('2026-10-30T10:00:00.000Z'),
          circleLinks: [{ circleID: 'circle-all' }],
        }),
      },
      assistantSubscription: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'sub-all',
            userID: 'user-1',
            circleID: 'circle-all',
            cities: [],
            keywords: [],
            sourceTypes: ['PLAZA_POST'],
            circle: { id: 'circle-all', name: '全国圈', cities: [] },
          },
        ]),
      },
      circleMember: {
        findMany: jest.fn().mockImplementation(activeMembersOf),
      },
      assistantAlertDelivery: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new AssistantSubscriptionService({} as never);

    await expect(
      service.enqueueCirclePost(tx as never, 'post-2', 'author-1', [
        'circle-all',
      ]),
    ).resolves.toBe(1);
  });

  it('matches any configured keyword against post content or tags', async () => {
    const tx = {
      circlePost: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'post-keyword',
          content: '周末城市活动',
          tags: ['演唱会'],
          city: '北京',
          cities: ['北京'],
          authorID: 'author-1',
          createdAt: new Date('2026-10-30T10:00:00.000Z'),
          circleLinks: [{ circleID: 'circle-1' }],
        }),
      },
      assistantSubscription: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'sub-match',
            userID: 'user-match',
            circleID: 'circle-1',
            cities: [],
            keywords: ['演唱会'],
            sourceTypes: ['PLAZA_POST'],
            pushEnabled: true,
            circle: { id: 'circle-1', name: '北京生活圈', cities: ['北京'] },
          },
          {
            id: 'sub-skip',
            userID: 'user-skip',
            circleID: 'circle-1',
            cities: [],
            keywords: ['招聘'],
            sourceTypes: ['PLAZA_POST'],
            pushEnabled: true,
            circle: { id: 'circle-1', name: '北京生活圈', cities: ['北京'] },
          },
        ]),
      },
      circleMember: {
        findMany: jest.fn().mockImplementation(activeMembersOf),
      },
      assistantAlertDelivery: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const service = new AssistantSubscriptionService({} as never);

    await expect(
      service.enqueueCirclePost(tx as never, 'post-keyword', 'author-1', [
        'circle-1',
      ]),
    ).resolves.toBe(1);
    expect(tx.assistantAlertDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ userID: 'user-match' })],
      }),
    );
  });

  it('skips subscribers who left the circle but keeps the owner without a member row', async () => {
    const post = {
      id: 'post-left',
      content: '圈内新活动',
      tags: [],
      city: null,
      cities: [],
      authorID: 'author-1',
      createdAt: new Date('2026-10-31T10:00:00.000Z'),
      circleLinks: [{ circleID: 'circle-1' }],
    };
    const subscription = (userID: string) => ({
      id: `sub-${userID}`,
      userID,
      circleID: 'circle-1',
      cities: [],
      keywords: [],
      sourceTypes: ['PLAZA_POST'],
      pushEnabled: true,
      circle: { id: 'circle-1', name: '圈子', cities: [], ownerID: 'owner-1' },
    });
    const tx = {
      circlePost: { findUnique: jest.fn().mockResolvedValue(post) },
      assistantSubscription: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            subscription('member-1'),
            subscription('left-1'),
            subscription('owner-1'),
          ]),
      },
      circleMember: {
        // left-1 退圈后订阅行还在,但已不是 ACTIVE 成员;群主没有成员行。
        findMany: jest
          .fn()
          .mockResolvedValue([{ circleID: 'circle-1', userID: 'member-1' }]),
      },
      assistantAlertDelivery: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const service = new AssistantSubscriptionService({} as never);

    await service.enqueueCirclePost(tx as never, 'post-left', 'author-1', [
      'circle-1',
    ]);

    expect(tx.circleMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
    const [{ data }] = tx.assistantAlertDelivery.createMany.mock.calls[0] as [
      { data: Array<{ userID: string }> },
    ];
    expect(
      data.map((row) => row.userID).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['member-1', 'owner-1']);
  });
});
