import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { CollectionService } from './collection.service';

describe('CollectionService', () => {
  let service: CollectionService;

  const prisma = {
    userCollection: {
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CollectionService>(CollectionService);
  });

  it('lists the current user collections by type', async () => {
    prisma.userCollection.findMany.mockResolvedValue([
      {
        id: 'collection-1',
        userID: 'user-1',
        type: 'CHAT',
        title: '收藏聊天记录',
        summary: '一段重要聊天',
        sourceID: 'msg-1',
        payload: null,
        createdAt: new Date('2026-04-22T12:00:00.000Z'),
        updatedAt: new Date('2026-04-22T12:00:00.000Z'),
      },
    ]);

    const items = await service.list('user-1', 'CHAT');

    expect(items).toHaveLength(1);
    expect(prisma.userCollection.findMany).toHaveBeenCalledWith({
      where: { userID: 'user-1', type: 'CHAT' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });

  it('creates a collection owned by the current user', async () => {
    prisma.userCollection.create.mockResolvedValue({
      id: 'collection-1',
      userID: 'user-1',
      type: 'NOTE',
      title: '旅行笔记',
      summary: '收藏的笔记',
      sourceID: 'note-1',
      payload: { noteId: 'note-1' },
      createdAt: new Date('2026-04-22T12:00:00.000Z'),
      updatedAt: new Date('2026-04-22T12:00:00.000Z'),
    });

    const item = await service.create('user-1', {
      type: 'NOTE',
      title: '旅行笔记',
      summary: '收藏的笔记',
      sourceID: 'note-1',
      payload: { noteId: 'note-1' },
    });

    expect(item.title).toBe('旅行笔记');
    expect(prisma.userCollection.create).toHaveBeenCalledWith({
      data: {
        userID: 'user-1',
        type: 'NOTE',
        title: '旅行笔记',
        summary: '收藏的笔记',
        sourceID: 'note-1',
        payload: { noteId: 'note-1' },
      },
    });
  });

  it('deletes only collections owned by the current user', async () => {
    prisma.userCollection.deleteMany.mockResolvedValue({ count: 0 });

    await expect(service.remove('user-1', 'collection-1')).rejects.toThrow(
      NotFoundException,
    );

    expect(prisma.userCollection.deleteMany).toHaveBeenCalledWith({
      where: { id: 'collection-1', userID: 'user-1' },
    });
  });
});
