import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { NotFoundException } from '@nestjs/common';
import { ChatHistoryService } from './chat-history.service';
import { ChatHistoryQueryDto } from './dto/chat-history.dto';

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
    const msgDocs = [
      {
        doc_id: `${singleConversationID}:0`,
        msgs: options.messages ?? [],
      },
    ];
    const msgFind = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue(msgDocs),
    });
    const groupFindOne = jest.fn().mockResolvedValue(options.groupMember ?? null);
    const db = {
      collection: jest.fn((name: string) => {
        if (name === 'msg') return { find: msgFind };
        if (name === 'group_member') return { findOne: groupFindOne };
        throw new Error(`unexpected collection ${name}`);
      }),
    };
    const service = new ChatHistoryService({ get: jest.fn() } as any);
    (service as any).getMongoDb = jest.fn().mockResolvedValue(db);
    return { service, db, msgFind, groupFindOne };
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
        session_type: 1,
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
});
