import { E2eeService } from './e2ee.service';

describe('burned encrypted message authorization', () => {
  const envelope = {
    senderDeviceId: 'device',
    conversationId: 'c1',
    clientMessageId: 'd1',
  };
  let tx: any;
  let service: any;
  beforeEach(() => {
    tx = {
      // 会话行一次 FOR SHARE(读回清空水位);APP 再锁一次本人座位。
      $queryRaw: jest.fn(({ sql }: { sql: string }) =>
        Promise.resolve(
          sql.includes('"ChatConversation"')
            ? [{ id: 'c1', clearedBeforeHeight: 0 }]
            : [],
        ),
      ),
      e2eeDevice: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'device', userID: 'sender' }]),
      },
      chatMessage: { findMany: jest.fn().mockResolvedValue([]) },
      chatBurnArchive: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'm1',
            conversationID: 'c1',
            senderID: 'sender',
            clientMessageId: 'd1',
            height: 1,
            retainUntil: new Date(Date.now() + 86400_000),
            content: { envelope },
          },
        ]),
      },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ adminAccess: { role: 'SUPER_ADMIN' } }),
      },
    };
    service = new E2eeService({} as never, {} as never);
  });
  it('never resolves retained content for a user application', async () => {
    expect(
      await service.visibleArchiveMessages(tx, 'user', 'APP', [envelope]),
    ).toEqual([null]);
    expect(tx.chatBurnArchive.findMany).not.toHaveBeenCalled();
  });
  it('requires archive permission in addition to normal audit read permission', async () => {
    tx.user.findUnique.mockResolvedValue({ adminAccess: { role: 'SUPPORT' } });
    expect(
      await service.visibleArchiveMessages(tx, 'admin', 'AUDIT', [envelope]),
    ).toEqual([null]);
    expect(tx.chatBurnArchive.findMany).not.toHaveBeenCalled();
  });
  it('allows an authorized audit device to resolve the retained envelope before its retention deadline', async () => {
    expect(
      await service.visibleArchiveMessages(tx, 'admin', 'AUDIT', [envelope]),
    ).toEqual([expect.objectContaining({ id: 'm1', content: { envelope } })]);
    expect(tx.chatBurnArchive.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { conversationID: 'c1', senderID: 'sender', clientMessageId: 'd1' },
        ],
        type: 'encrypted-text',
        retainUntil: { gt: expect.any(Date) },
      },
    });
    // 一批引用只锁一次会话行。
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
