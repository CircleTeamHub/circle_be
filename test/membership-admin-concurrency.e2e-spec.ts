import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { MembershipErrorCode } from 'src/common/app-error-codes';
import { MembershipBenefitType, NotificationType } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { getE2eApp } from './e2e-context';

function canRunPostgresE2e(): boolean {
  const databaseUrl = process.env.DATABASE_URL;
  if (process.env.NODE_ENV !== 'test' || !databaseUrl || !process.env.SECRET) {
    return false;
  }

  try {
    const url = new URL(databaseUrl);
    const databaseName = decodeURIComponent(url.pathname.slice(1));
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      /(^|[_-])test($|[_-])/i.test(databaseName)
    );
  } catch {
    return false;
  }
}

const describePostgres = canRunPostgresE2e() ? describe : describe.skip;

describePostgres('Membership admin grant concurrency e2e', () => {
  let prisma: PrismaService;
  let adminToken: string;
  let operatorId: string;

  const createUser = async (role: 'ADMIN' | 'USER' = 'USER') => {
    const id = randomUUID();
    const suffix = id.split('-').join('').slice(0, 10);
    return prisma.user.create({
      data: {
        id,
        accountId: `membership-e2e-${suffix}`,
        inviteCode: suffix.slice(0, 6),
        passwordHash: 'not-used',
        nickname: `Membership ${suffix}`,
        role,
      },
    });
  };

  const grant = (targetUserId: string, idempotencyKey: string) =>
    request(getE2eApp().getHttpServer())
      .post(`/api/v1/admin/memberships/users/${targetUserId}/grants`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ targetLevel: 3, idempotencyKey, note: 'parallel e2e' });

  const expectSingleMutation = async (targetUserIds: string[]) => {
    await expect(
      prisma.membershipGrant.count({
        where: { targetUserID: { in: targetUserIds } },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.membershipBenefitGrant.count({
        where: {
          userID: { in: targetUserIds },
          type: MembershipBenefitType.STANDARD_FANCY_NUMBER,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.user.count({
        where: { id: { in: targetUserIds }, vipLevel: 3 },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.notification.count({
        where: {
          toUserID: { in: targetUserIds },
          type: NotificationType.SYSTEM,
        },
      }),
    ).resolves.toBe(1);
  };

  beforeEach(async () => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);
    // Sign with the auth SECRET explicitly — app.get(JwtService) may resolve a
    // different JwtModule instance keyed on a secret CI does not set.
    const jwtSecret = app.get(ConfigService).get<string>('SECRET') ?? '';
    const operator = await createUser('ADMIN');
    operatorId = operator.id;
    adminToken = jwt.sign(
      {
        sub: operator.id,
        accountId: operator.accountId,
        role: 'ADMIN',
        aud: 'ADMIN',
      },
      { secret: jwtSecret, expiresIn: '5m' },
    );
  });

  afterEach(async () => {
    await prisma.notificationPushOutbox.deleteMany();
    await prisma.notification.deleteMany();
    await prisma.membershipBenefitGrant.deleteMany();
    await prisma.membershipGrant.deleteMany();
  });

  it('converges duplicate requests for the same target and key', async () => {
    const target = await createUser();
    const idempotencyKey = randomUUID();

    const responses = await Promise.all([
      grant(target.id, idempotencyKey),
      grant(target.id, idempotencyKey),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(
      responses
        .map(({ body }) => body.data.replayed)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    await expectSingleMutation([target.id]);
    await expect(
      prisma.membershipGrant.findFirst({
        where: { targetUserID: target.id },
        select: { operatorUserID: true },
      }),
    ).resolves.toEqual({ operatorUserID: operatorId });
  });

  it('allows only one of two conflicting upgrades with different keys', async () => {
    const target = await createUser();

    const responses = await Promise.all([
      grant(target.id, randomUUID()),
      grant(target.id, randomUUID()),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    const conflict = responses.find(({ status }) => status === 409);
    expect(conflict?.body.errorCode).toBe(MembershipErrorCode.LevelNotHigher);
    await expectSingleMutation([target.id]);
  });

  it('allows one target when the same key races across different targets', async () => {
    const targets = await Promise.all([createUser(), createUser()]);
    const idempotencyKey = randomUUID();

    const responses = await Promise.all(
      targets.map((target) => grant(target.id, idempotencyKey)),
    );

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    const conflict = responses.find(({ status }) => status === 409);
    expect(conflict?.body.errorCode).toBe(
      MembershipErrorCode.IdempotencyConflict,
    );
    await expectSingleMutation(targets.map(({ id }) => id));
  });
});
