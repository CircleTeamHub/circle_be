import { TempChatStatus } from 'src/generated/prisma';
import { TempChatCleanup } from './temp-chat.cleanup';

describe('TempChatCleanup', () => {
  const prisma = { tempChat: { findMany: jest.fn() } };
  const service = { teardown: jest.fn() };
  const job = new TempChatCleanup(prisma as any, service as any);

  beforeEach(() => jest.clearAllMocks());

  it('tears down every ACTIVE expired room', async () => {
    prisma.tempChat.findMany.mockResolvedValue([
      { id: 'a', groupId: 'tmpA' },
      { id: 'b', groupId: 'tmpB' },
    ]);
    await job.sweep();
    expect(service.teardown).toHaveBeenCalledTimes(2);
    expect(service.teardown).toHaveBeenCalledWith(
      { id: 'a', groupId: 'tmpA' },
      TempChatStatus.EXPIRED,
    );
  });

  it('one failing room does not block the others', async () => {
    prisma.tempChat.findMany.mockResolvedValue([
      { id: 'a', groupId: 'tmpA' },
      { id: 'b', groupId: 'tmpB' },
    ]);
    service.teardown.mockRejectedValueOnce(new Error('boom'));
    await job.sweep();
    expect(service.teardown).toHaveBeenCalledTimes(2);
  });
});
