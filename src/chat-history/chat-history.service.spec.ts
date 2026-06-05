import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { NotFoundException } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { ChatHistoryService } from './chat-history.service';
import { ChatHistoryQueryDto } from './dto/chat-history.dto';

jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    close: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn().mockResolvedValue(undefined),
    db: jest.fn().mockReturnValue({ collection: jest.fn() }),
  })),
}));

describe('ChatHistory DTOs', () => {
  it('caps message page size through query validation metadata', () => {
    const dto = plainToInstance(ChatHistoryQueryDto, {
      limit: '500',
      beforeSeq: '42',
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });
});

describe('ChatHistoryService', () => {
  const currentUserId = '0a9ad3d6-ef1d-47bd-9cbc-cda1cee57547';
  const currentImUserId = '0a9ad3d6ef1d47bd9cbccda1cee57547';
  const peerImUserId = 'd6bbe83841ea4a0dae8689d5509c1881';
  const singleConversationID = `si_${currentImUserId}_${peerImUserId}`;

  function createService(options: {
    messages?: any[];
    groupMember?: any | null;
  }) {
    const msgFind = jest.fn();
    const msgAggregate = jest.fn((pipeline: any[]) => {
      const visibleMessages = (options.messages ?? [])
        .filter((wrapper) => wrapper?.msg)
        .filter((wrapper) => !wrapper.del_list?.includes(currentImUserId))
        .sort((left, right) => Number(left.msg.seq) - Number(right.msg.seq));
      const beforeSeqStage = pipeline
        .flatMap((stage) => stage?.$facet?.page ?? [])
        .find((stage) => stage?.$match?.['msg.seq']?.$lt);
      const beforeSeq = beforeSeqStage?.$match?.['msg.seq']?.$lt;
      const page = visibleMessages
        .filter((wrapper) => beforeSeq == null || Number(wrapper.msg.seq) < beforeSeq)
        .slice()
        .sort((left, right) => Number(right.msg.seq) - Number(left.msg.seq))
        .slice(0, 201);
      return {
        toArray: jest.fn().mockResolvedValue([
          {
            stats:
              visibleMessages.length > 0
                ? [
                    {
                      serverMinSeq: visibleMessages[0].msg.seq,
                      serverMaxSeq:
                        visibleMessages[visibleMessages.length - 1].msg.seq,
                    },
                  ]
                : [],
            page,
          },
        ]),
      };
    });
    const groupFindOne = jest.fn().mockResolvedValue(options.groupMember ?? null);
    const db = {
      collection: jest.fn((name: string) => {
        if (name === 'msg') return { aggregate: msgAggregate, find: msgFind };
        if (name === 'group_member') return { findOne: groupFindOne };
        throw new Error(`unexpected collection ${name}`);
      }),
    };
    const service = new ChatHistoryService({ get: jest.fn() } as any);
    (service as any).getMongoDb = jest.fn().mockResolvedValue(db);
    return { service, db, msgAggregate, msgFind, groupFindOne };
  }

  function wrapper(seq: number, overrides: Record<string, unknown> = {}) {
    return {
      msg: {
        client_msg_id: `client-${seq}`,
        server_msg_id: `server-${seq}`,
        send_id: currentImUserId,
        recv_id: peerImUserId,
        group_id: '',
        sender_nickname: 'meiguici',
        sender_face_url: 'https://example.com/a.jpg',
        sender_platform_id: 1,
        session_type: 1,
        msg_from: 100,
        content_type: 101,
        status: 2,
        seq,
        send_time: 1000 + seq,
        create_time: 900 + seq,
        content: JSON.stringify({ content: `message ${seq}` }),
        attached_info: 'null',
        ex: '',
        ...overrides,
      },
      del_list: [],
      is_read: false,
    };
  }

  it('returns single conversation messages only when the current user is a participant', async () => {
    const { service } = createService({
      messages: [
        wrapper(1),
        { msg: null, del_list: [] },
        wrapper(2, { client_msg_id: 'deleted-for-current-user' }),
        wrapper(3),
      ].map((item, index) =>
        index === 2 ? { ...item, del_list: [currentImUserId] } : item,
      ),
    });

    const page = await service.getMessages(currentUserId, singleConversationID, 100);

    expect(page.messages.map((message) => message.clientMsgID)).toEqual([
      'client-1',
      'client-3',
    ]);
    expect(page.serverMinSeq).toBe(1);
    expect(page.serverMaxSeq).toBe(3);
    expect(page.hasMore).toBe(false);
    expect(page.messages[0].senderPlatformID).toBe(1);
    expect(page.messages[0].msgFrom).toBe(100);
  });

  it('returns 404 for a third-party single conversation read', async () => {
    const { service } = createService({ messages: [wrapper(1)] });

    await expect(
      service.getMessages(
        'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        singleConversationID,
        100,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('checks group membership before returning group messages', async () => {
    const groupConversationID = 'sg_2272071933';
    const { service, groupFindOne } = createService({
      groupMember: { group_id: '2272071933', user_id: currentImUserId },
      messages: [
        wrapper(1, {
          recv_id: '',
          group_id: '2272071933',
          session_type: 3,
        }),
      ],
    });

    const page = await service.getMessages(currentUserId, groupConversationID, 100);

    expect(groupFindOne).toHaveBeenCalledWith({
      group_id: '2272071933',
      user_id: currentImUserId,
    });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].groupID).toBe('2272071933');
  });

  it('paginates by beforeSeq and returns nextBeforeSeq', async () => {
    const { service } = createService({
      messages: [wrapper(1), wrapper(2), wrapper(3), wrapper(4), wrapper(5)],
    });

    const page = await service.getMessages(currentUserId, singleConversationID, 2, 5);

    expect(page.messages.map((message) => message.seq)).toEqual([3, 4]);
    expect(page.nextBeforeSeq).toBe(3);
    expect(page.hasMore).toBe(true);
  });

  it('pushes visible-message pagination into Mongo aggregation', async () => {
    const { service, msgAggregate, msgFind } = createService({
      messages: [wrapper(1), wrapper(2), wrapper(3)],
    });

    await service.getMessages(currentUserId, singleConversationID, 2, 3);

    expect(msgFind).not.toHaveBeenCalled();
    expect(msgAggregate).toHaveBeenCalledWith([
      { $match: { doc_id: { $regex: `^${singleConversationID}:` } } },
      { $project: { msgs: 1 } },
      { $unwind: '$msgs' },
      { $replaceRoot: { newRoot: '$msgs' } },
      {
        $match: {
          msg: { $ne: null },
          'msg.seq': { $exists: true },
          del_list: { $ne: currentImUserId },
        },
      },
      {
        $facet: {
          stats: [
            {
              $group: {
                _id: null,
                serverMaxSeq: { $max: '$msg.seq' },
                serverMinSeq: { $min: '$msg.seq' },
              },
            },
          ],
          page: [
            { $match: { 'msg.seq': { $lt: 3 } } },
            { $sort: { 'msg.seq': -1 } },
            { $limit: 3 },
          ],
        },
      },
    ]);
  });

  it('uses bounded Mongo connection timeouts for the OpenIM history store', async () => {
    const config = {
      get: jest.fn((key: string) =>
        key === 'OPENIM_MONGO_URI' ? 'mongodb://localhost:27017/openim_v3' : null,
      ),
    };
    const service = new ChatHistoryService(config as any);

    await (service as any).getMongoDb();

    expect(MongoClient).toHaveBeenCalledWith(
      'mongodb://localhost:27017/openim_v3',
      expect.objectContaining({
        connectTimeoutMS: 3_000,
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 3_000,
      }),
    );
  });
});
