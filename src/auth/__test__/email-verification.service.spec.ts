import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { EmailVerificationService } from '../email-verification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MAILER } from '../mailer/mailer.interface';

describe('EmailVerificationService', () => {
  let service: EmailVerificationService;
  let codes: any[];
  let usersByEmail: Set<string>;
  const mailer = { sendVerificationCode: jest.fn(() => Promise.resolve()) };

  const mockPrisma: any = {
    // requestCode 的删旧+建新走 advisory 锁事务；mock 直接把自身当 tx 用。
    $transaction: jest.fn(async (fn: any) => fn(mockPrisma)),
    $queryRaw: jest.fn(async () => []),
    emailVerificationCode: {
      findFirst: jest.fn(({ where }) => {
        const list = codes
          .filter(
            (c) =>
              c.email === where.email &&
              c.purpose === where.purpose &&
              (where.consumedAt === undefined || c.consumedAt === null) &&
              (!where.expiresAt || c.expiresAt > where.expiresAt.gt),
          )
          .sort((a, b) => b.createdAt - a.createdAt);
        return Promise.resolve(list[0] ?? null);
      }),
      deleteMany: jest.fn(({ where }) => {
        codes = codes.filter((c) => {
          if (where.id !== undefined) return c.id !== where.id;
          const matches =
            c.email === where.email &&
            c.purpose === where.purpose &&
            c.consumedAt === null &&
            // round 3：送达后的清理只删更旧的行
            (where.createdAt?.lt === undefined ||
              c.createdAt < where.createdAt.lt);
          return !matches;
        });
        return Promise.resolve({ count: 0 });
      }),
      create: jest.fn(({ data }) => {
        // createdAt 必须是 Date（真实 Prisma 行为）——requestCode 冷却逻辑会调用 .getTime()。
        const row = {
          id: `c-${codes.length}`,
          attempts: 0,
          consumedAt: null,
          createdAt: new Date(),
          ...data,
        };
        codes.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(({ where, data }) => {
        const row = codes.find((c) => c.id === where.id);
        if (data.attempts?.increment) row.attempts += data.attempts.increment;
        if (data.consumedAt) row.consumedAt = data.consumedAt;
        return Promise.resolve(row);
      }),
    },
    user: {
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(usersByEmail.has(where.email) ? { id: 'u1' } : null),
      ),
    },
  };

  beforeEach(async () => {
    codes = [];
    usersByEmail = new Set();
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailVerificationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MAILER, useValue: mailer },
      ],
    }).compile();
    service = module.get(EmailVerificationService);
  });

  it('requestCode(register) sends a code and stores a hash', async () => {
    await service.requestCode('a@b.com', 'REGISTER');
    expect(mailer.sendVerificationCode).toHaveBeenCalledTimes(1);
    expect(codes).toHaveLength(1);
    expect(codes[0].codeHash).not.toMatch(/^\d{6}$/); // hashed, not plaintext
  });

  it('requestCode(register) is silent for an already-registered email (F-07 anti-enumeration)', async () => {
    usersByEmail.add('a@b.com');
    // Must not reveal that the email is taken: no error, no code sent/stored.
    // The duplicate is caught at registration commit by the email unique
    // constraint (whose error is generic — see F-06).
    await service.requestCode('a@b.com', 'REGISTER');
    expect(mailer.sendVerificationCode).not.toHaveBeenCalled();
    expect(codes).toHaveLength(0);
  });

  it('requestCode(login) is silent (no send) for unknown email', async () => {
    await service.requestCode('ghost@b.com', 'LOGIN');
    expect(mailer.sendVerificationCode).not.toHaveBeenCalled();
    expect(codes).toHaveLength(0);
  });

  it('requestCode enforces a resend cooldown', async () => {
    usersByEmail.add('a@b.com');
    await service.requestCode('a@b.com', 'LOGIN');
    await expect(service.requestCode('a@b.com', 'LOGIN')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rolls the code row back when mail delivery fails, so retry is not cooldown-locked', async () => {
    usersByEmail.add('a@b.com');
    mailer.sendVerificationCode.mockRejectedValueOnce(
      new Error('454 relay refused'),
    );

    await expect(service.requestCode('a@b.com', 'LOGIN')).rejects.toThrow(
      ServiceUnavailableException,
    );
    // 没送达的行必须删掉：否则它占住 60s 冷却，用户重试只会拿到 CodeRateLimited
    expect(codes).toHaveLength(0);

    // 立刻重试可以直接成功（不撞冷却）
    await service.requestCode('a@b.com', 'LOGIN');
    expect(codes).toHaveLength(1);
    expect(mailer.sendVerificationCode).toHaveBeenCalledTimes(2);
  });

  it('keeps the previously delivered code usable when a resend fails (round 2)', async () => {
    usersByEmail.add('a@b.com');
    // 第一封成功送达
    await service.requestCode('a@b.com', 'LOGIN');
    expect(codes).toHaveLength(1);
    const oldRow = codes[0];
    // 冷却期外的重发：SMTP 失败
    oldRow.createdAt = new Date(Date.now() - 61_000);
    mailer.sendVerificationCode.mockRejectedValueOnce(new Error('454 relay'));

    await expect(service.requestCode('a@b.com', 'LOGIN')).rejects.toThrow(
      ServiceUnavailableException,
    );

    // 旧行必须原封仍在（新行已回滚）——用户手里那封信还能用
    expect(codes).toHaveLength(1);
    expect(codes[0].id).toBe(oldRow.id);
  });

  it('redacts recipient addresses out of SMTP failure logs (round 2)', async () => {
    usersByEmail.add('a@b.com');
    const smtpError = Object.assign(
      new Error('454 4.7.1 <a@b.com>: Relay access denied'),
      { responseCode: 454, name: 'SMTPError' },
    );
    mailer.sendVerificationCode.mockRejectedValueOnce(smtpError);
    const errorSpy = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    await expect(service.requestCode('a@b.com', 'LOGIN')).rejects.toThrow(
      ServiceUnavailableException,
    );

    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('a@b.com');
    expect(logged).toContain('responseCode=454');
    errorSpy.mockRestore();
  });

  it('fails identically for known and unknown emails when the mailer is unavailable (round 3 P1)', async () => {
    usersByEmail.add('known@b.com');
    (mailer as any).isAvailable = jest.fn(() => false);
    try {
      // 已注册与未注册必须拿到同一个 503 —— 差异即账号枚举 oracle
      await expect(service.requestCode('known@b.com', 'LOGIN')).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(service.requestCode('ghost@b.com', 'LOGIN')).rejects.toThrow(
        ServiceUnavailableException,
      );
      // 且都发生在任何 DB 写入之前
      expect(codes).toHaveLength(0);
    } finally {
      delete (mailer as any).isAvailable;
    }
  });

  it('rejects an older unconsumed code once a newer row exists (round 3)', async () => {
    const oldHash = await argon2.hash('111111');
    const newHash = await argon2.hash('222222');
    const past = new Date(Date.now() - 30_000);
    codes.push(
      {
        id: 'old',
        email: 'a@b.com',
        purpose: 'LOGIN',
        codeHash: oldHash,
        attempts: 0,
        consumedAt: null,
        createdAt: past,
        expiresAt: new Date(Date.now() + 9 * 60_000),
      },
      {
        id: 'new',
        email: 'a@b.com',
        purpose: 'LOGIN',
        codeHash: newHash,
        attempts: 0,
        consumedAt: new Date(), // 新码已被消费
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    );

    // 清理失败残留的旧码不能在新码消费后复活成第二把钥匙
    await expect(
      service.verifyCode('a@b.com', 'LOGIN', '111111'),
    ).resolves.toBe(false);
  });

  it('re-checks the cooldown inside the serialized transaction (concurrent double-send guard)', async () => {
    usersByEmail.add('a@b.com');
    // 模拟并发对手：外层冷却快查时还没有行，进锁复检时对手的行已经出现。
    mockPrisma.emailVerificationCode.findFirst
      .mockResolvedValueOnce(null) // 外层快查
      .mockResolvedValueOnce({ createdAt: new Date() }); // 锁内复检

    await expect(service.requestCode('a@b.com', 'LOGIN')).rejects.toThrow(
      BadRequestException,
    );
    expect(mockPrisma.emailVerificationCode.create).not.toHaveBeenCalled();
    expect(mailer.sendVerificationCode).not.toHaveBeenCalled();
    // 锁确实被拿了
    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
  });

  it('verifyCode succeeds once then is consumed', async () => {
    const codeHash = await argon2.hash('123456');
    codes.push({
      id: 'c0',
      email: 'a@b.com',
      purpose: 'LOGIN',
      codeHash,
      attempts: 0,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60000),
      createdAt: Date.now(),
    });
    await expect(
      service.verifyCode('a@b.com', 'LOGIN', '123456'),
    ).resolves.toBe(true);
    await expect(
      service.verifyCode('a@b.com', 'LOGIN', '123456'),
    ).resolves.toBe(false);
  });

  it('verifyCode returns false for wrong code and counts attempts', async () => {
    const codeHash = await argon2.hash('123456');
    codes.push({
      id: 'c0',
      email: 'a@b.com',
      purpose: 'LOGIN',
      codeHash,
      attempts: 0,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60000),
      createdAt: Date.now(),
    });
    await expect(
      service.verifyCode('a@b.com', 'LOGIN', '000000'),
    ).resolves.toBe(false);
    expect(codes[0].attempts).toBe(1);
  });

  it('verifyCode returns false when expired', async () => {
    const codeHash = await argon2.hash('123456');
    codes.push({
      id: 'c0',
      email: 'a@b.com',
      purpose: 'LOGIN',
      codeHash,
      attempts: 0,
      consumedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      createdAt: Date.now(),
    });
    await expect(
      service.verifyCode('a@b.com', 'LOGIN', '123456'),
    ).resolves.toBe(false);
  });

  it('verifyCode accepts the dev bypass code when EMAIL_CODE_DEV_BYPASS is explicitly set', async () => {
    const prev = process.env.EMAIL_CODE_DEV_BYPASS;
    process.env.EMAIL_CODE_DEV_BYPASS = '999999';
    try {
      // 没有 seed 任何验证码记录，显式开启后该码应直接通过（dev 占位）。
      await expect(
        service.verifyCode('nobody@b.com', 'LOGIN', '999999'),
      ).resolves.toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EMAIL_CODE_DEV_BYPASS;
      else process.env.EMAIL_CODE_DEV_BYPASS = prev;
    }
  });

  it('verifyCode has NO bypass by default when EMAIL_CODE_DEV_BYPASS is unset (F-05)', async () => {
    const prev = process.env.EMAIL_CODE_DEV_BYPASS;
    delete process.env.EMAIL_CODE_DEV_BYPASS;
    try {
      // No built-in default code: a shared/staging env without the opt-in var
      // must not accept the well-known 999999.
      await expect(
        service.verifyCode('nobody@b.com', 'LOGIN', '999999'),
      ).resolves.toBe(false);
    } finally {
      if (prev !== undefined) process.env.EMAIL_CODE_DEV_BYPASS = prev;
    }
  });

  it('verifyCode dev bypass can be disabled via EMAIL_CODE_DEV_BYPASS=off', async () => {
    const prev = process.env.EMAIL_CODE_DEV_BYPASS;
    process.env.EMAIL_CODE_DEV_BYPASS = 'off';
    try {
      await expect(
        service.verifyCode('nobody@b.com', 'LOGIN', '999999'),
      ).resolves.toBe(false);
    } finally {
      process.env.EMAIL_CODE_DEV_BYPASS = prev;
    }
  });
});
