import { SensitiveWordAdminController } from './sensitive-word-admin.controller';

const req = {
  user: { userId: 'admin-1' },
  ip: '1.2.3.4',
  headers: { 'user-agent': 'jest' },
} as any;

describe('SensitiveWordAdminController', () => {
  const service = {
    listWords: jest.fn().mockResolvedValue({ total: 0, words: [] }),
    addWords: jest.fn().mockResolvedValue({ requested: 2, added: 2 }),
    removeWords: jest.fn().mockResolvedValue({ removed: 1 }),
  } as any;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as any;
  const controller = new SensitiveWordAdminController(service, audit);

  beforeEach(() => jest.clearAllMocks());

  it('list 透传服务结果', async () => {
    await expect(controller.list()).resolves.toEqual({ total: 0, words: [] });
  });

  it('add 调服务并写审计', async () => {
    const result = await controller.add({ words: ['赌博', 'casino'] }, req);
    expect(result).toEqual({ requested: 2, added: 2 });
    expect(service.addWords).toHaveBeenCalledWith(
      ['赌博', 'casino'],
      'admin-1',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorID: 'admin-1',
        action: 'sensitive_word.add',
        ip: '1.2.3.4',
      }),
    );
  });

  it('remove 调服务并写审计', async () => {
    const result = await controller.remove({ words: ['赌博'] }, req);
    expect(result).toEqual({ removed: 1 });
    expect(service.removeWords).toHaveBeenCalledWith(['赌博'], 'admin-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sensitive_word.remove' }),
    );
  });
});
