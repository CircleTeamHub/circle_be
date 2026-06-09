import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { NotFoundException } from '@nestjs/common';
import { ChatHistoryService } from './chat-history.service';
import { ChatHistoryQueryDto } from './dto/chat-history.dto';
import type { OpenimMessage, OpenimService } from 'src/openim/openim.service';

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

  function makeMsg(
    seq: number,
    over: Partial<OpenimMessage> = {},
  ): OpenimMessage {
    return {
      clientMsgID: `c${seq}`,
      serverMsgID: `s${seq}`,
      sendID: currentImUserId,
      recvID: peerImUserId,
      groupID: '',
      senderPlatformID: 1,
      senderNickname: 'me',
      senderFaceURL: '',
      sessionType: 1,
      msgFrom: 200,
      contentType: 101,
      content: `content-${seq}`,
      seq,
      sendTime: 1000 + seq,
      createTime: 1000 + seq,
      status: 0,
      isRead: false,
      attachedInfo: '',
      ex: '',
      ...over,
    };
  }

  function createService(openim: Partial<OpenimService>) {
    return new ChatHistoryService(openim as OpenimService);
  }

  it('returns single-conversation messages, sorted ascending, when the user is a participant', async () => {
    const pullConversationMessages = jest
      .fn()
      .mockResolvedValue({ messages: [makeMsg(2), makeMsg(1)], isEnd: true });
    const service = createService({
      getConversationMaxSeq: jest.fn().mockResolvedValue(2),
      pullConversationMessages,
    });

    const page = await service.getMessages(
      currentUserId,
      singleConversationID,
      100,
    );

    expect(page.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(page.serverMaxSeq).toBe(2);
    expect(page.serverMinSeq).toBeNull();
    expect(page.hasMore).toBe(false);
    expect(pullConversationMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationID: singleConversationID,
        end: 2,
        num: 100,
      }),
    );
  });

  it('maps OpenIM camelCase fields onto the restorable DTO (incl. faceURL→faceUrl)', async () => {
    const service = createService({
      getConversationMaxSeq: jest.fn().mockResolvedValue(1),
      pullConversationMessages: jest.fn().mockResolvedValue({
        messages: [
          makeMsg(1, { senderFaceURL: 'http://x/a.png', clientMsgID: 'cid' }),
        ],
        isEnd: true,
      }),
    });

    const page = await service.getMessages(
      currentUserId,
      singleConversationID,
      100,
    );

    expect(page.messages[0]).toMatchObject({
      clientMsgID: 'cid',
      senderFaceUrl: 'http://x/a.png',
      seq: 1,
      contentType: 101,
    });
  });

  it('returns 404 for a third-party single-conversation read (never hits OpenIM)', async () => {
    const getConversationMaxSeq = jest.fn();
    const service = createService({ getConversationMaxSeq });

    await expect(
      service.getMessages(
        '99999999-0000-0000-0000-000000000000',
        singleConversationID,
        100,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(getConversationMaxSeq).not.toHaveBeenCalled();
  });

  it('rejects a group read from a non-member with 404', async () => {
    const isGroupMember = jest.fn().mockResolvedValue(false);
    const service = createService({
      isGroupMember,
      getConversationMaxSeq: jest.fn(),
    });

    await expect(
      service.getMessages(currentUserId, 'sg_group-1', 100),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(isGroupMember).toHaveBeenCalledWith('group-1', currentImUserId);
  });

  it('returns group messages for a current member', async () => {
    const service = createService({
      isGroupMember: jest.fn().mockResolvedValue(true),
      getConversationMaxSeq: jest.fn().mockResolvedValue(1),
      pullConversationMessages: jest
        .fn()
        .mockResolvedValue({ messages: [makeMsg(1)], isEnd: true }),
    });

    const page = await service.getMessages(currentUserId, 'sg_group1', 100);

    expect(page.messages).toHaveLength(1);
  });

  it('returns an empty page (without pulling) for an empty conversation', async () => {
    const pullConversationMessages = jest.fn();
    const service = createService({
      getConversationMaxSeq: jest.fn().mockResolvedValue(0),
      pullConversationMessages,
    });

    const page = await service.getMessages(
      currentUserId,
      singleConversationID,
      100,
    );

    expect(page.messages).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(pullConversationMessages).not.toHaveBeenCalled();
  });

  it('paginates by beforeSeq (exclusive) and returns nextBeforeSeq when a full page remains', async () => {
    const pullConversationMessages = jest
      .fn()
      .mockResolvedValue({ messages: [makeMsg(5), makeMsg(4)], isEnd: false });
    const service = createService({
      getConversationMaxSeq: jest.fn().mockResolvedValue(10),
      pullConversationMessages,
    });

    const page = await service.getMessages(
      currentUserId,
      singleConversationID,
      2,
      6,
    );

    // beforeSeq 6 → end 5 (exclusive)
    expect(pullConversationMessages).toHaveBeenCalledWith(
      expect.objectContaining({ end: 5, num: 2 }),
    );
    expect(page.messages.map((message) => message.seq)).toEqual([4, 5]);
    expect(page.hasMore).toBe(true);
    expect(page.nextBeforeSeq).toBe(4);
  });

  it('stops paginating (hasMore false) when an under-filled page comes back', async () => {
    const service = createService({
      getConversationMaxSeq: jest.fn().mockResolvedValue(10),
      pullConversationMessages: jest
        .fn()
        .mockResolvedValue({ messages: [makeMsg(1)], isEnd: true }),
    });

    const page = await service.getMessages(
      currentUserId,
      singleConversationID,
      50,
      3,
    );

    expect(page.hasMore).toBe(false);
    expect(page.nextBeforeSeq).toBeNull();
  });
});
