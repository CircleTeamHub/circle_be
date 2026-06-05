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
    sequence?: { min_seq?: number; max_seq?: number } | null;
    messageShardExists?: boolean;
    maxShardDocs?: number;
  }) {
    const msgFind = jest.fn();
    const msgFindOne = jest
      .fn()
      .mockResolvedValue(
        options.messageShardExists ? { _id: 'shard-0' } : null,
      );
    const msgAggregate = jest.fn((pipeline: any[]) => {
      const docIDs = pipeline.find((stage) => stage?.$match?.doc_id)?.$match
        ?.doc_id?.$in;
      const visibleMessages = (options.messages ?? [])
        .filter(
          (wrapper) =>
            !docIDs ||
            docIDs.some((docID: string) =>
              docID.endsWith(
                `:${Math.floor((Number(wrapper?.msg?.seq) - 1) / 100)}`,
              ),
            ),
        )
        .filter((wrapper) => wrapper?.msg)
        .filter((wrapper) => !wrapper.del_list?.includes(currentImUserId))
        .sort((left, right) => Number(left.msg.seq) - Number(right.msg.seq));
      const beforeSeqStage = pipeline
        .filter((stage) => stage?.$match?.['msg.seq'])
        .find((stage) => stage?.$match?.['msg.seq']?.$lt);
      const beforeSeq = beforeSeqStage?.$match?.['msg.seq']?.$lt;
      const minSeqStage = pipeline
        .filter((stage) => stage?.$match?.['msg.seq'])
        .find((stage) => stage?.$match?.['msg.seq']?.$gte);
      const minSeq = minSeqStage?.$match?.['msg.seq']?.$gte;
      const limit =
        pipeline.find((stage) => typeof stage?.$limit === 'number')?.$limit ??
        201;
      const page = visibleMessages
        .filter(
          (wrapper) =>
            (beforeSeq == null || Number(wrapper.msg.seq) < beforeSeq) &&
            (minSeq == null || Number(wrapper.msg.seq) >= minSeq),
        )
        .slice()
        .sort((left, right) => Number(right.msg.seq) - Number(left.msg.seq))
        .slice(0, limit);
      return {
        toArray: jest.fn().mockResolvedValue(page),
      };
    });
    const groupFindOne = jest
      .fn()
      .mockResolvedValue(options.groupMember ?? null);
    const allSeqs = (options.messages ?? [])
      .map((message) => Number(message?.msg?.seq))
      .filter(Number.isFinite);
    const defaultSequence =
      allSeqs.length > 0
        ? { min_seq: Math.min(...allSeqs), max_seq: Math.max(...allSeqs) }
        : null;
    const seqFindOne = jest
      .fn()
      .mockResolvedValue(
        options.sequence === undefined ? defaultSequence : options.sequence,
      );
    const db = {
      collection: jest.fn((name: string) => {
        if (name === 'msg')
          return {
            aggregate: msgAggregate,
            find: msgFind,
            findOne: msgFindOne,
          };
        if (name === 'group_member') return { findOne: groupFindOne };
        if (name === 'seq') return { findOne: seqFindOne };
        throw new Error(`unexpected collection ${name}`);
      }),
    };
    const configGet = jest.fn((key: string) =>
      key === 'OPENIM_HISTORY_MAX_SHARD_DOCS' &&
      options.maxShardDocs !== undefined
        ? options.maxShardDocs
        : undefined,
    );
    const service = new ChatHistoryService({ get: configGet } as any);
    (service as any).getMongoDb = jest.fn().mockResolvedValue(db);
    return {
      service,
      db,
      msgAggregate,
      msgFind,
      msgFindOne,
      groupFindOne,
      seqFindOne,
    };
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

    const page = await service.getMessages(
      currentUserId,
      singleConversationID,
      100,
    );

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

    const page = await service.getMessages(
      currentUserId,
      groupConversationID,
      100,
    );

    expect(groupFindOne).toHaveBeenCalledWith(
      {
        group_id: '2272071933',
        user_id: currentImUserId,
      },
      expect.objectContaining({ maxTimeMS: 5_000 }),
    );
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].groupID).toBe('2272071933');
  });

  it('paginates by beforeSeq and returns nextBeforeSeq', async () => {
    const { service } = createService({
      messages: [wrapper(1), wrapper(2), wrapper(3), wrapper(4), wrapper(5)],
    });

    const page = await service.getMessages(
      currentUserId,
      singleConversationID,
      2,
      5,
    );

    expect(page.messages.map((message) => message.seq)).toEqual([3, 4]);
    expect(page.nextBeforeSeq).toBe(3);
    expect(page.hasMore).toBe(true);
  });

  it('pushes visible-message pagination into exact OpenIM message shard lookups', async () => {
    const { service, msgAggregate, msgFind, seqFindOne } = createService({
      messages: [wrapper(1), wrapper(2), wrapper(3)],
    });

    await service.getMessages(currentUserId, singleConversationID, 2, 3);

    expect(seqFindOne).toHaveBeenCalledWith(
      { conversation_id: singleConversationID },
      {
        projection: { _id: 0, max_seq: 1, min_seq: 1 },
        maxTimeMS: 5_000,
      },
    );
    expect(msgFind).not.toHaveBeenCalled();
    expect(msgAggregate).toHaveBeenCalledWith(
      [
        { $match: { doc_id: { $in: [`${singleConversationID}:0`] } } },
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
        { $match: { 'msg.seq': { $lt: 3 } } },
        { $sort: { 'msg.seq': -1 } },
        { $limit: 3 },
      ],
      { maxTimeMS: 5_000 },
    );
  });

  it('continues through older exact shards until the page is full', async () => {
    const { service, msgAggregate } = createService({
      messages: [wrapper(1), wrapper(401)],
      sequence: { min_seq: 1, max_seq: 401 },
    });

    const page = await service.getMessages(
      currentUserId,
      singleConversationID,
      2,
    );

    expect(page.messages.map((message) => message.seq)).toEqual([1, 401]);
    expect(msgAggregate).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining([
        { $match: { doc_id: { $in: [`${singleConversationID}:4`] } } },
      ]),
      expect.objectContaining({ maxTimeMS: 5_000 }),
    );
    expect(msgAggregate).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        { $match: { doc_id: { $in: [`${singleConversationID}:0`] } } },
      ]),
      expect.objectContaining({ maxTimeMS: 5_000 }),
    );
  });

  it('bounds the shard scan and returns a resume cursor for sparse history', async () => {
    const { service, msgAggregate } = createService({
      messages: [],
      sequence: { min_seq: 1, max_seq: 100_000 },
    });

    const page = await service.getMessages(
      currentUserId,
      singleConversationID,
      2,
    );

    // A 1,000-shard conversation with no visible messages must not turn one
    // read into ~1,000 sequential Mongo round-trips.
    expect(msgAggregate.mock.calls.length).toBeLessThanOrEqual(20);
    expect(page.messages).toEqual([]);
    // The scan stopped early on the budget, so the client gets a cursor to
    // keep walking older shards instead of believing it reached the end.
    expect(page.hasMore).toBe(true);
    expect(page.nextBeforeSeq).not.toBeNull();
    expect(page.nextBeforeSeq!).toBeLessThan(100_000);
  });

  it('reports a Mongo read failure as a 503 without leaking driver detail', async () => {
    const { service, seqFindOne } = createService({ messages: [wrapper(1)] });
    seqFindOne.mockRejectedValueOnce(
      new Error('connection refused mongodb://secret-host:27017'),
    );

    await expect(
      service.getMessages(currentUserId, singleConversationID, 100),
    ).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({
        message: 'OpenIM history store is unavailable',
      }),
    });
  });

  it('warns when the seq doc is missing but message shards exist', async () => {
    const { service, msgFindOne } = createService({
      messages: [],
      sequence: null,
      messageShardExists: true,
    });
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    const page = await service.getMessages(
      currentUserId,
      singleConversationID,
      100,
    );

    expect(page.messages).toEqual([]);
    expect(page.serverMaxSeq).toBeNull();
    expect(msgFindOne).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('seq doc missing');
    // The conversation id (which embeds participant IM ids) must not leak.
    expect(warn.mock.calls[0][0]).not.toContain(currentImUserId);
  });

  it('stays silent for a genuinely empty conversation with no shards', async () => {
    const { service } = createService({
      messages: [],
      sequence: null,
      messageShardExists: false,
    });
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    const page = await service.getMessages(
      currentUserId,
      singleConversationID,
      100,
    );

    expect(page.messages).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('honors the configurable shard-scan budget override', async () => {
    const { service, msgAggregate } = createService({
      messages: [],
      sequence: { min_seq: 1, max_seq: 100_000 },
      maxShardDocs: 5,
    });

    await service.getMessages(currentUserId, singleConversationID, 2);

    expect(msgAggregate.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('does not restore messages below the OpenIM conversation min seq', async () => {
    const { service } = createService({
      messages: [wrapper(301), wrapper(401)],
      sequence: { min_seq: 350, max_seq: 401 },
    });

    const page = await service.getMessages(
      currentUserId,
      singleConversationID,
      2,
    );

    expect(page.serverMinSeq).toBe(350);
    expect(page.messages.map((message) => message.seq)).toEqual([401]);
  });

  it('uses bounded Mongo connection timeouts for the OpenIM history store', async () => {
    const config = {
      get: jest.fn((key: string) =>
        key === 'OPENIM_MONGO_URI'
          ? 'mongodb://localhost:27017/openim_v3'
          : null,
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
