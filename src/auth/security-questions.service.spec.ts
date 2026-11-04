import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as argon2 from 'argon2';
import {
  normalizeSecurityAnswer,
  SecurityQuestionsService,
} from './security-questions.service';

type Row = {
  userId: string;
  questionKey: string;
  answerHash: string;
  position: number;
};

async function setup() {
  const rows: Row[] = [];
  const users: Record<string, { passwordHash: string }> = {
    u1: { passwordHash: await argon2.hash('password1') },
  };
  const ofUser = (userId: string) =>
    rows
      .filter((row) => row.userId === userId)
      .sort((a, b) => a.position - b.position);
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }) => users[where.id] ?? null),
    },
    userSecurityQuestion: {
      findMany: jest.fn(async ({ where }) => ofUser(where.userId)),
      deleteMany: jest.fn(({ where }) => ({ op: 'delete', where })),
      createMany: jest.fn(({ data }) => ({ op: 'create', data })),
    },
    $transaction: jest.fn(
      async (ops: Array<{ op: string; where?: any; data?: Row[] }>) => {
        for (const op of ops) {
          if (op.op === 'delete') {
            for (let i = rows.length - 1; i >= 0; i -= 1) {
              if (rows[i].userId === op.where.userId) rows.splice(i, 1);
            }
          } else {
            rows.push(...op.data!);
          }
        }
      },
    ),
  };
  const service = new SecurityQuestionsService(prisma as never);
  return { service, rows, prisma };
}

const QUESTIONS = [
  { questionKey: 'bestFriendName', answer: '张三' },
  { questionKey: 'primarySchool', answer: 'Sunshine Primary' },
];

describe('normalizeSecurityAnswer', () => {
  it('ignores width, whitespace and letter case', () => {
    expect(normalizeSecurityAnswer('  Ｓｕｎｓｈｉｎｅ  Primary ')).toBe(
      'sunshineprimary',
    );
    expect(normalizeSecurityAnswer('张 三')).toBe('张三');
    expect(normalizeSecurityAnswer(' \t ')).toBe('');
  });
});

describe('SecurityQuestionsService', () => {
  it('stores two questions with hashed answers, never the answers themselves', async () => {
    const { service, rows } = await setup();

    await service.set('u1', 'password1', QUESTIONS);

    expect(rows.map((row) => row.questionKey)).toEqual([
      'bestFriendName',
      'primarySchool',
    ]);
    expect(rows.map((row) => row.position)).toEqual([0, 1]);
    for (const row of rows) {
      expect(row.answerHash).toMatch(/^\$argon2/);
      expect(row.answerHash).not.toContain('张三');
    }
    await expect(service.questionKeys('u1')).resolves.toEqual([
      'bestFriendName',
      'primarySchool',
    ]);
  });

  it('replaces the previous questions instead of adding to them', async () => {
    const { service, rows } = await setup();
    await service.set('u1', 'password1', QUESTIONS);
    await service.set('u1', 'password1', [
      { questionKey: 'birthCity', answer: '杭州' },
      { questionKey: 'firstPetName', answer: '豆豆' },
    ]);
    expect(rows.map((row) => row.questionKey)).toEqual([
      'birthCity',
      'firstPetName',
    ]);
  });

  it('requires the current password, so a stolen session cannot set up a login fallback', async () => {
    const { service, rows } = await setup();
    await expect(
      service.set('u1', 'wrong-password', QUESTIONS),
    ).rejects.toMatchObject({
      response: { errorCode: 'AUTH_PASSWORD_INCORRECT' },
    });
    await expect(
      service.set('u1', 'wrong-password', QUESTIONS),
    ).rejects.toThrow(ForbiddenException);
    expect(rows).toHaveLength(0);
  });

  it('rejects the same question twice or an answer that is only whitespace', async () => {
    const { service, rows } = await setup();
    await expect(
      service.set('u1', 'password1', [
        { questionKey: 'birthCity', answer: '杭州' },
        { questionKey: 'birthCity', answer: '上海' },
      ]),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.set('u1', 'password1', [
        { questionKey: 'birthCity', answer: '杭州' },
        { questionKey: 'firstPetName', answer: '   ' },
      ]),
    ).rejects.toMatchObject({
      response: { errorCode: 'AUTH_SECURITY_QUESTIONS_INVALID' },
    });
    expect(rows).toHaveLength(0);
  });

  it('accepts both answers in the order they were set, forgiving case and spacing', async () => {
    const { service } = await setup();
    await service.set('u1', 'password1', QUESTIONS);

    await expect(
      service.verifyAnswers('u1', ['张 三', 'sunshine primary']),
    ).resolves.toBe(true);
    await expect(
      service.verifyAnswers('u1', ['张三', 'Moonlight Primary']),
    ).resolves.toBe(false);
    await expect(
      service.verifyAnswers('u1', ['Sunshine Primary', '张三']),
    ).resolves.toBe(false);
  });

  it('has nothing to verify against when no questions were set', async () => {
    const { service } = await setup();
    await expect(service.questionKeys('u1')).resolves.toEqual([]);
    await expect(service.verifyAnswers('u1', ['a', 'b'])).resolves.toBe(false);
  });
});
