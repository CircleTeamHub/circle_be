import { PrismaService } from 'src/prisma/prisma.service';
import { CreditPolicyService } from './credit-policy.service';

describe('CreditPolicyService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
  };
  let service: CreditPolicyService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CreditPolicyService(prisma as unknown as PrismaService);
  });

  it('checks OpenIM hyphenless user ids against the database UUID', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: '287653c5-f38a-4a80-b977-5bfc26635a05',
      creditScore: 59,
    });

    await expect(
      service.checkOpenimSend('287653c5f38a4a80b9775bfc26635a05'),
    ).resolves.toEqual({
      allowed: false,
      code: 'LOW_CREDIT_SCORE',
      currentScore: 59,
      minScore: 60,
      message: '信誉值低于 60，暂时无法发送消息',
    });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { id: '287653c5f38a4a80b9775bfc26635a05' },
          { id: '287653c5-f38a-4a80-b977-5bfc26635a05' },
        ],
      },
      select: { id: true, creditScore: true },
    });
  });

  it('allows OpenIM callback checks for users unknown to the app database', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(service.checkOpenimSend('temp-guest')).resolves.toBeNull();
  });

  it('caches OpenIM callback send decisions for repeated messages', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: '287653c5-f38a-4a80-b977-5bfc26635a05',
      creditScore: 100,
    });

    await expect(
      service.checkOpenimSend('287653c5f38a4a80b9775bfc26635a05'),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      service.checkOpenimSend('287653c5f38a4a80b9775bfc26635a05'),
    ).resolves.toMatchObject({ allowed: true });

    expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached OpenIM callback decisions after a credit score change', async () => {
    prisma.user.findFirst
      .mockResolvedValueOnce({
        id: '287653c5-f38a-4a80-b977-5bfc26635a05',
        creditScore: 100,
      })
      .mockResolvedValueOnce({
        id: '287653c5-f38a-4a80-b977-5bfc26635a05',
        creditScore: 59,
      });

    await expect(
      service.checkOpenimSend('287653c5f38a4a80b9775bfc26635a05'),
    ).resolves.toMatchObject({ allowed: true });
    service.invalidateUserPolicyCache('287653c5-f38a-4a80-b977-5bfc26635a05');

    await expect(
      service.checkOpenimSend('287653c5f38a4a80b9775bfc26635a05'),
    ).resolves.toMatchObject({
      allowed: false,
      code: 'LOW_CREDIT_SCORE',
    });
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(2);
  });
});
