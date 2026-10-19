import { AdminImService } from './admin-im.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatGroupAdminService } from 'src/chat/chat-group-admin.service';
import { GroupService } from 'src/group/group.service';
import { UploadService } from 'src/upload/upload.service';
it('returns the associated circle label using the existing batch lookup', async () => {
  const prisma = {
    chatConversation: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'chat',
          type: 'GROUP',
          name: null,
          circleID: 'circle',
          members: [{ userID: 'user', alias: null }],
          _count: { members: 1 },
        },
      ]),
      count: jest.fn().mockResolvedValue(1),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([{ id: 'user', nickname: '用户' }]),
    },
    circle: {
      findMany: jest.fn().mockResolvedValue([{ id: 'circle', name: '学习圈' }]),
    },
  };
  const service = new AdminImService(
    prisma as unknown as PrismaService,
    {} as ChatGroupAdminService,
    {} as GroupService,
    {} as UploadService,
  );
  const result = await service.list({ page: 1, limit: 20 });
  expect(result.items[0]).toMatchObject({
    name: '学习圈',
    circle: { id: 'circle', name: '学习圈' },
    participants: [{ id: 'user', nickname: '用户' }],
    memberCount: 1,
  });
  expect(prisma.circle.findMany).toHaveBeenCalledTimes(1);
  prisma.circle.findMany.mockResolvedValue([]);
  expect(
    (await service.list({ page: 1, limit: 20 })).items[0].circle,
  ).toBeNull();
});
