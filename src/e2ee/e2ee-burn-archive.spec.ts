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
      $queryRaw: jest.fn(),
      e2eeDevice: {
        findUnique: jest.fn().mockResolvedValue({ userID: 'sender' }),
      },
      chatMessage: { findFirst: jest.fn().mockResolvedValue(null) },
      chatBurnArchive: {
        findFirst: jest
          .fn()
          .mockResolvedValue({
            id: 'm1',
            height: 1,
            retainUntil: new Date(Date.now() + 86400_000),
            content: { envelope },
          }),
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
      await service.visibleArchiveMessage(tx, 'user', 'APP', envelope),
    ).toBeNull();
    expect(tx.chatBurnArchive.findFirst).not.toHaveBeenCalled();
  });
  it('requires archive permission in addition to normal audit read permission', async () => {
    tx.user.findUnique.mockResolvedValue({ adminAccess: { role: 'SUPPORT' } });
    expect(
      await service.visibleArchiveMessage(tx, 'admin', 'AUDIT', envelope),
    ).toBeNull();
    expect(tx.chatBurnArchive.findFirst).not.toHaveBeenCalled();
  });
  it('allows an authorized audit device to resolve the retained envelope before its retention deadline', async () => {
    expect(
      await service.visibleArchiveMessage(tx, 'admin', 'AUDIT', envelope),
    ).toMatchObject({ id: 'm1', content: { envelope } });
    expect(tx.chatBurnArchive.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        retainUntil: { gt: expect.any(Date) },
        senderID: 'sender',
        clientMessageId: 'd1',
      }),
    });
  });
});
