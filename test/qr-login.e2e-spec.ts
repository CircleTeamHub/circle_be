import request from 'supertest';
import { PrismaService } from 'src/prisma/prisma.service';
import { getE2eApp } from './e2e-context';

const BYPASS_CODE = '999999';

describe('QR login e2e', () => {
  it('resolves, approves, and atomically delivers one browser session', async () => {
    const app = getE2eApp();
    const server = app.getHttpServer();
    const prisma = app.get(PrismaService);

    const registration = await request(server)
      .post('/api/v1/auth/register')
      .send({
        email: 'qr-login-e2e@example.com',
        code: BYPASS_CODE,
        password: 'password1',
        nickname: 'QR Login User',
      })
      .expect(201);
    const mobileAccessToken = registration.body.data.accessToken as string;

    const created = await request(server)
      .post('/api/v1/auth/qr-login')
      .set('User-Agent', 'Mozilla/5.0 Chrome/140.0 macOS')
      .expect(201);
    const { qrToken, pollKey, verificationCode } = created.body.data as {
      qrToken: string;
      pollKey: string;
      verificationCode: string;
    };
    expect(qrToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(pollKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(verificationCode).toMatch(/^\d{6}$/);

    await request(server)
      .get(`/api/v1/qr/tokens/${qrToken}`)
      .set('Authorization', `Bearer ${mobileAccessToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({
          type: 'LOGIN',
          verificationCode,
        });
        expect(body.data.requestDevice).toEqual(expect.any(String));
      });

    await request(server)
      .post(`/api/v1/auth/qr-login/${qrToken}/status`)
      .send({ pollKey: 'x'.repeat(32) })
      .expect(200)
      .expect(({ body }) => expect(body.data).toEqual({ status: 'EXPIRED' }));

    await request(server)
      .post(`/api/v1/auth/qr-login/${qrToken}/approve`)
      .set('Authorization', `Bearer ${mobileAccessToken}`)
      .expect(201)
      .expect(({ body }) => expect(body.data).toEqual({ ok: true }));

    const poll = () =>
      request(server)
        .post(`/api/v1/auth/qr-login/${qrToken}/status`)
        .set('x-device-name', 'Desktop browser')
        .send({ pollKey })
        .expect(200);
    const responses = await Promise.all([poll(), poll()]);
    const results = responses.map((response) => response.body.data);
    const approved = results.filter((result) => result.status === 'APPROVED');
    const expired = results.filter((result) => result.status === 'EXPIRED');

    expect(approved).toHaveLength(1);
    expect(expired).toHaveLength(1);
    expect(approved[0].tokens).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });

    const row = await prisma.qrLoginSession.findUnique({ where: { qrToken } });
    expect(row).toMatchObject({ status: 'CONSUMED' });
    expect(row?.consumedAt).toBeInstanceOf(Date);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'qr-login-e2e@example.com' },
      select: { id: true },
    });
    await expect(
      prisma.refreshToken.count({
        where: {
          userId: user.id,
          audience: 'APP',
          deviceName: 'Desktop browser',
          revokedAt: null,
        },
      }),
    ).resolves.toBe(1);
  });

  it('rejects approval from banned and admin accounts', async () => {
    const app = getE2eApp();
    const server = app.getHttpServer();
    const prisma = app.get(PrismaService);

    for (const account of [
      { email: 'qr-banned@example.com', status: 'BANNED' as const },
      { email: 'qr-admin@example.com', role: 'ADMIN' as const },
    ]) {
      const registration = await request(server)
        .post('/api/v1/auth/register')
        .send({
          email: account.email,
          code: BYPASS_CODE,
          password: 'password1',
          nickname: 'Ineligible QR User',
        })
        .expect(201);
      const accessToken = registration.body.data.accessToken as string;
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: account.email },
        select: { id: true },
      });
      await prisma.user.update({
        where: { id: user.id },
        data:
          'status' in account
            ? { status: account.status }
            : { role: account.role },
      });

      const created = await request(server)
        .post('/api/v1/auth/qr-login')
        .expect(201);
      const qrToken = created.body.data.qrToken as string;

      await request(server)
        .post(`/api/v1/auth/qr-login/${qrToken}/approve`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);

      await expect(
        prisma.qrLoginSession.findUniqueOrThrow({
          where: { qrToken },
          select: { status: true, approvedByID: true },
        }),
      ).resolves.toEqual({ status: 'PENDING', approvedByID: null });
    }
  });
});
