import * as pactum from 'pactum';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationService } from 'src/notification/notification.service';
import { NotificationPushService } from 'src/notification/notification-push.service';
import { DeviceTrustService } from 'src/auth/device-trust.service';
import { AuthService } from 'src/auth/auth.service';
import { getE2eApp } from './e2e-context';

// Runs in the existing fresh-DB CI harness, never against the application DB.
describe('Device-bound security push e2e', () => {
  async function fixture() {
    const app = getE2eApp();
    const db = app.get(PrismaService);
    const userId = randomUUID();
    await db.accountIdentifier.create({ data: { value: userId } });
    await db.user.create({
      data: {
        id: userId,
        accountId: userId,
        inviteCode: userId,
        passwordHash: 'test-only',
        nickname: 'push-test',
      },
    });
    const keys = ['current', 'removed', 'expired'];
    const sessions = {} as Record<string, string>;
    for (const key of keys) {
      await db.trustedDevice.create({ data: { userId, deviceKey: key } });
      const session = await db.refreshToken.create({
        data: {
          userId,
          token: randomUUID(),
          deviceKey: key,
          expiredAt: new Date(
            Date.now() + (key === 'expired' ? -60_000 : 60_000),
          ),
        },
      });
      sessions[key] = session.id;
      await db.devicePushToken.create({
        data: {
          userID: userId,
          token: `ExponentPushToken[${key}]`,
          provider: 'expo',
          platform: 'ios',
          deviceKey: key,
        },
      });
    }
    await db.devicePushToken.create({
      data: {
        userID: userId,
        token: 'ExponentPushToken[legacy]',
        provider: 'expo',
        platform: 'ios',
      },
    });
    const alerts = new NotificationPushService(db, app.get(ConfigService));
    const sent = jest.spyOn(alerts, 'sendToTokens').mockResolvedValue([]);
    const trust = new DeviceTrustService(db, { broadcast() {} } as any, alerts);
    return { db, userId, sessions, alerts, sent, trust, app };
  }

  it('binds from the signed session, excludes legacy/expired devices and revokes removed addresses', async () => {
    const h = await fixture();
    const jwt = h.app.get(JwtService).sign(
      {
        sub: h.userId,
        accountId: h.userId,
        role: 'USER',
        aud: 'APP',
        sid: h.sessions.current,
      },
      { secret: process.env.SECRET },
    );
    await pactum
      .spec()
      .put('/api/v1/notification/push-token')
      .withHeaders({
        Authorization: `Bearer ${jwt}`,
        'X-Device-Id': 'not-the-session-device',
      })
      .withBody({
        token: 'ExponentPushToken[current]',
        provider: 'expo',
        platform: 'ios',
      })
      .expectStatus(200)
      .expectJsonLike({ data: { deviceBound: true } });
    expect(
      (
        await h.db.devicePushToken.findUnique({
          where: { token: 'ExponentPushToken[current]' },
        })
      )?.deviceKey,
    ).toBe('current');
    expect(
      (await h.alerts.listLoginAlertTokens(h.userId))
        .map((t) => t.token)
        .sort(),
    ).toEqual(['ExponentPushToken[current]', 'ExponentPushToken[removed]']);
    await h.app
      .get(AuthService)
      .logoutSession(h.userId, h.sessions.removed, h.sessions.current);
    expect(
      (
        await h.db.devicePushToken.findUnique({
          where: { token: 'ExponentPushToken[removed]' },
        })
      )?.disabledAt,
    ).toBeInstanceOf(Date);
    await expect(
      h.app.get(NotificationService).registerPushToken(
        h.userId,
        {
          token: 'ExponentPushToken[removed]',
          provider: 'expo',
          platform: 'ios',
        },
        h.sessions.removed,
      ),
    ).rejects.toMatchObject({ status: 403 });
    for (const type of ['auth.login.challenge.created', 'auth.device.added']) {
      await (h.trust as any).pushToUser(h.userId, {
        title: 'test',
        body: 'test',
        data: { type },
      });
    }
    expect(h.sent).toHaveBeenCalledTimes(2);
    for (const [targets] of h.sent.mock.calls)
      expect(targets.map((t) => t.token)).toEqual([
        'ExponentPushToken[current]',
      ]);
    await h.app
      .get(AuthService)
      .logoutOtherSessions(h.userId, h.sessions.current);
    expect(
      (
        await h.db.devicePushToken.findUnique({
          where: { token: 'ExponentPushToken[legacy]' },
        })
      )?.disabledAt,
    ).toBeInstanceOf(Date);
    expect(
      (await h.alerts.listLoginAlertTokens(h.userId)).map((t) => t.token),
    ).toEqual(['ExponentPushToken[current]']);
  });

  it('a push queued behind remote removal rechecks eligibility after the account lock', async () => {
    const h = await fixture();
    let entered!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const removal = h.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth_session:${h.userId}`}, 0))`;
      entered();
      await barrier;
      await h.trust.revokeDevice(h.userId, 'removed');
    });
    await ready;
    const push = (h.trust as any).pushToUser(h.userId, {
      title: 'test',
      body: 'test',
      data: { type: 'auth.login.challenge.created' },
    });
    const registration = h.app.get(NotificationService).registerPushToken(
      h.userId,
      {
        token: 'ExponentPushToken[removed]',
        provider: 'expo',
        platform: 'ios',
      },
      h.sessions.removed,
    );
    const registrationResult = registration.then(
      () => 'accepted',
      () => 'rejected',
    );
    resume();
    await Promise.all([removal, push]);
    expect(await registrationResult).toBe('rejected');
    expect(
      h.sent.mock.calls.flatMap(([tokens]) => tokens.map((t) => t.token)),
    ).toEqual(['ExponentPushToken[current]']);
  });
});
