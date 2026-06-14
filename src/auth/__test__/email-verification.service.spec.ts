import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { EmailVerificationService } from '../email-verification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MAILER } from '../mailer/mailer.interface';

describe('EmailVerificationService', () => {
  let service: EmailVerificationService;
  let codes: any[];
  let usersByEmail: Set<string>;
  const mailer = { sendVerificationCode: jest.fn(() => Promise.resolve()) };

  const mockPrisma = {
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
        codes = codes.filter(
          (c) =>
            !(
              c.email === where.email &&
              c.purpose === where.purpose &&
              c.consumedAt === null
            ),
        );
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

  it('requestCode(register) throws if email already registered', async () => {
    usersByEmail.add('a@b.com');
    await expect(service.requestCode('a@b.com', 'REGISTER')).rejects.toThrow(
      ConflictException,
    );
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

  it('verifyCode accepts the dev bypass code without a stored record', async () => {
    // 没有 seed 任何验证码记录，999999 仍应直接通过（dev 占位）。
    await expect(
      service.verifyCode('nobody@b.com', 'LOGIN', '999999'),
    ).resolves.toBe(true);
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
