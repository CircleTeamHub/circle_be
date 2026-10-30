import { AssistantSubscriptionService } from './assistant-subscription.service';

describe('AssistantSubscriptionService', () => {
  it('matches a post against the current circle cities and skips other cities', async () => {
    const tx = {
      circlePost: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'post-1',
          content: '北京周末活动',
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
            sourceTypes: ['PLAZA_POST'],
            circle: { id: 'circle-1', name: '北京生活圈', cities: ['北京'] },
          },
          {
            id: 'sub-shanghai',
            userID: 'user-shanghai',
            circleID: 'circle-1',
            cities: [],
            sourceTypes: ['PLAZA_POST'],
            circle: { id: 'circle-1', name: '上海生活圈', cities: ['上海'] },
          },
        ]),
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
            sourceTypes: ['PLAZA_POST'],
            circle: { id: 'circle-all', name: '全国圈', cities: [] },
          },
        ]),
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
});
