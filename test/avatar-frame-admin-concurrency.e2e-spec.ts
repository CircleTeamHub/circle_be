import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from 'src/prisma/prisma.service';
import { assertSafeE2eDatabase } from './app.factory';
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

describePostgres('Avatar-frame admin grant concurrency e2e', () => {
  let prisma: PrismaService;
  let adminToken: string;
  let operatorId: string;

  const createUser = async (role: 'ADMIN' | 'USER' = 'USER') => {
    const id = randomUUID();
    const suffix = id.replace(/-/g, '').slice(0, 10);
    return prisma.user.create({
      data: {
        id,
        accountId: `avatar-frame-e2e-${suffix}`,
        inviteCode: suffix.slice(0, 6),
        passwordHash: 'not-used',
        nickname: `Avatar frame ${suffix}`,
        role,
      },
    });
  };

  beforeEach(async () => {
    assertSafeE2eDatabase();
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    const jwt = app.get(JwtService);
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

  it('converges concurrent same-key grants to one grant and one strict audit row', async () => {
    const target = await createUser();
    const frame = await prisma.avatarFrameAsset.create({
      data: {
        key: `admin-e2e-${randomUUID()}`,
        name: 'Admin concurrency e2e',
        description: 'Disposable concurrency test asset',
        minimumVipLevel: null,
        isActive: true,
        sortOrder: 9999,
      },
    });
    const idempotencyKey = randomUUID();
    const payload = {
      frameId: frame.id,
      expiresAt: null,
      reason: 'parallel avatar-frame e2e',
      idempotencyKey,
    };
    const grantRequest = () =>
      request(getE2eApp().getHttpServer())
        .post(`/api/v1/admin/avatar-frames/users/${target.id}/grants`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

    const responses = await Promise.all([grantRequest(), grantRequest()]);

    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(
      responses
        .map(({ body }) => body.data.replayed)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    const responseGrantIds = responses.map(
      ({ body }) => body.data.grant.id as string,
    );
    expect(new Set(responseGrantIds).size).toBe(1);

    const rows = await prisma.userAvatarFrameGrant.findMany({
      where: { idempotencyKey },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: responseGrantIds[0],
      userID: target.id,
      frameID: frame.id,
      operatorUserID: operatorId,
      reason: payload.reason,
      expiresAt: null,
      revokedAt: null,
    });

    const audits = await prisma.adminAuditLog.findMany({
      where: {
        action: 'avatar_frame_grant_created',
        entityType: 'UserAvatarFrameGrant',
        entityID: rows[0].id,
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorID: operatorId,
      reason: payload.reason,
      before: null,
    });
    expect(audits[0].after).toMatchObject({
      id: rows[0].id,
      userId: target.id,
      frameId: frame.id,
      operatorUserId: operatorId,
      idempotencyKey,
      reason: payload.reason,
      expiresAt: null,
      revokedAt: null,
    });
  });

  it('converges concurrent revokes and tightens selection to the remaining finite grant', async () => {
    const target = await createUser();
    const frame = await prisma.avatarFrameAsset.create({
      data: {
        key: `admin-revoke-e2e-${randomUUID()}`,
        name: 'Admin revoke concurrency e2e',
        description: 'Disposable revoke concurrency test asset',
        minimumVipLevel: null,
        isActive: true,
        sortOrder: 9999,
      },
    });
    const remainingExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [permanentGrant, remainingGrant] = await Promise.all([
      prisma.userAvatarFrameGrant.create({
        data: {
          id: randomUUID(),
          userID: target.id,
          frameID: frame.id,
          operatorUserID: operatorId,
          idempotencyKey: randomUUID(),
          reason: 'permanent source to revoke',
          expiresAt: null,
        },
      }),
      prisma.userAvatarFrameGrant.create({
        data: {
          id: randomUUID(),
          userID: target.id,
          frameID: frame.id,
          operatorUserID: operatorId,
          idempotencyKey: randomUUID(),
          reason: 'remaining finite source',
          expiresAt: remainingExpiry,
        },
      }),
    ]);
    await prisma.user.update({
      where: { id: target.id },
      data: {
        selectedAvatarFrameID: frame.id,
        selectedAvatarFrameExpiresAt: null,
      },
    });
    const reason = 'concurrent revoke e2e';
    const revokeRequest = () =>
      request(getE2eApp().getHttpServer())
        .post(`/api/v1/admin/avatar-frames/grants/${permanentGrant.id}/revoke`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason });

    const responses = await Promise.all([revokeRequest(), revokeRequest()]);

    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(
      responses
        .map(({ body }) => body.data.replayed)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    expect(
      new Set(responses.map(({ body }) => body.data.grant.id as string)).size,
    ).toBe(1);

    await expect(
      prisma.userAvatarFrameGrant.findUniqueOrThrow({
        where: { id: permanentGrant.id },
        select: {
          revokedAt: true,
          revokedByUserID: true,
          revokeReason: true,
        },
      }),
    ).resolves.toEqual({
      revokedAt: expect.any(Date),
      revokedByUserID: operatorId,
      revokeReason: reason,
    });
    await expect(
      prisma.userAvatarFrameGrant.findUniqueOrThrow({
        where: { id: remainingGrant.id },
        select: {
          expiresAt: true,
          revokedAt: true,
        },
      }),
    ).resolves.toEqual({
      expiresAt: remainingExpiry,
      revokedAt: null,
    });
    await expect(
      prisma.adminAuditLog.count({
        where: {
          action: 'avatar_frame_grant_revoked',
          entityType: 'UserAvatarFrameGrant',
          entityID: permanentGrant.id,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.user.findUniqueOrThrow({
        where: { id: target.id },
        select: {
          selectedAvatarFrameID: true,
          selectedAvatarFrameExpiresAt: true,
        },
      }),
    ).resolves.toEqual({
      selectedAvatarFrameID: frame.id,
      selectedAvatarFrameExpiresAt: remainingExpiry,
    });
  });
});
