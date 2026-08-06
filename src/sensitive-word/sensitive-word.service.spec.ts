import { Test } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { SensitiveWordService } from './sensitive-word.service';

const row = (word: string) => ({
  id: `id-${word}`,
  word,
  createdAt: new Date('2026-08-05T00:00:00Z'),
  createdBy: 'admin-1',
});

describe('SensitiveWordService', () => {
  let service: SensitiveWordService;

  const prisma = {
    sensitiveWord: {
      findMany: jest.fn(),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.sensitiveWord.findMany.mockResolvedValue([row('赌博'), row('casino')]);
    const module = await Test.createTestingModule({
      providers: [
        SensitiveWordService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(SensitiveWordService);
  });

  it('onModuleInit 加载词表后 check 命中', async () => {
    await service.onModuleInit();
    expect(service.check('来赌博吗')).toEqual({ blocked: true, word: '赌博' });
    expect(service.check('normal text')).toEqual({ blocked: false });
  });

  it('未加载（启动加载失败）时 fail-open 放行', async () => {
    prisma.sensitiveWord.findMany.mockRejectedValueOnce(new Error('db down'));
    await service.onModuleInit(); // 不抛出
    expect(service.check('来赌博吗')).toEqual({ blocked: false });
  });

  it('空词表放行', async () => {
    prisma.sensitiveWord.findMany.mockResolvedValue([]);
    await service.onModuleInit();
    expect(service.check('来赌博吗')).toEqual({ blocked: false });
  });

  it('addWords 规范化去重入库并立刻生效', async () => {
    await service.onModuleInit();
    prisma.sensitiveWord.findMany.mockResolvedValue([
      row('赌博'),
      row('casino'),
      row('毒品'),
    ]);
    await service.addWords(['  毒品 ', '毒品', 'ＤＵ品', ''], 'admin-1');
    expect(prisma.sensitiveWord.createMany).toHaveBeenCalledWith({
      data: [
        { word: '毒品', createdBy: 'admin-1' },
        { word: 'du品', createdBy: 'admin-1' },
      ],
      skipDuplicates: true,
    });
    expect(service.check('有毒品吗')).toEqual({ blocked: true, word: '毒品' });
  });

  it('addWords 全部为空词时不触库', async () => {
    await service.onModuleInit();
    await service.addWords(['', '   '], 'admin-1');
    expect(prisma.sensitiveWord.createMany).not.toHaveBeenCalled();
  });

  it('removeWords 规范化后删除并立刻生效', async () => {
    await service.onModuleInit();
    prisma.sensitiveWord.findMany.mockResolvedValue([row('casino')]);
    await service.removeWords([' 赌博 '], 'admin-1');
    expect(prisma.sensitiveWord.deleteMany).toHaveBeenCalledWith({
      where: { word: { in: ['赌博'] } },
    });
    expect(service.check('来赌博吗')).toEqual({ blocked: false });
  });

  it('listWords 返回词表', async () => {
    prisma.sensitiveWord.findMany.mockResolvedValue([row('赌博')]);
    const result = await service.listWords();
    expect(result.total).toBe(1);
    expect(result.words[0]).toMatchObject({ word: '赌博' });
  });

  it('TTL 过期后 check 触发后台刷新（不阻塞当前判定）', async () => {
    jest.useFakeTimers();
    try {
      await service.onModuleInit();
      prisma.sensitiveWord.findMany.mockClear();
      prisma.sensitiveWord.findMany.mockResolvedValue([row('新词')]);

      jest.advanceTimersByTime(61_000);
      // 旧缓存仍即时生效（同步返回），同时踢一次后台刷新
      expect(service.check('新词来了')).toEqual({ blocked: false });
      expect(prisma.sensitiveWord.findMany).toHaveBeenCalledTimes(1);

      await jest.runOnlyPendingTimersAsync();
      expect(service.check('新词来了')).toEqual({ blocked: true, word: '新词' });
    } finally {
      jest.useRealTimers();
    }
  });
});
