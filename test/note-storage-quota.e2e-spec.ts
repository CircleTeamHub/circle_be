import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { NoteErrorCode } from 'src/common/app-error-codes';
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

describePostgres('Note storage quota concurrency e2e', () => {
  let prisma: PrismaService;
  let jwt: JwtService;
  // Sign with the auth SECRET explicitly: app.get(JwtService) can resolve a
  // different JwtModule instance (e.g. temp-chat's, keyed on a secret CI never
  // sets), so relying on the module default yields "secretOrPrivateKey must
  // have a value" and forges tokens the auth strategy would reject anyway.
  let jwtSecret: string;

  const createUser = async (label: string) => {
    const id = randomUUID();
    const suffix = id.replace(/-/g, '').slice(0, 10);
    return prisma.user.create({
      data: {
        id,
        accountId: `${label}-${suffix}`,
        inviteCode: suffix.slice(0, 6),
        passwordHash: 'not-used',
        nickname: `${label} ${suffix}`,
      },
    });
  };

  const accessToken = (user: { id: string; accountId: string }) =>
    jwt.sign(
      {
        sub: user.id,
        accountId: user.accountId,
        role: 'USER',
        aud: 'APP',
      },
      { secret: jwtSecret, expiresIn: '5m' },
    );

  const createRequest = (token: string, title: string) =>
    request(getE2eApp().getHttpServer())
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${token}`)
      .send({ title, media: [] });

  const expectOneQuotaWinner = async (
    userID: string,
    requests: Array<PromiseLike<{ status: number; body: unknown }>>,
  ) => {
    const responses = await Promise.all(requests);
    expect(responses.map(({ status }) => status).sort((a, b) => a - b)).toEqual(
      [201, 403],
    );
    const rejected = responses.find(({ status }) => status === 403);
    expect(rejected?.body).toMatchObject({
      errorCode: NoteErrorCode.StorageQuotaReached,
      data: { quota: 'notes', limit: 50, current: 50 },
    });
    await expect(
      prisma.note.count({
        where: { ownerID: userID, status: { not: 'DELETED' } },
      }),
    ).resolves.toBe(50);
  };

  beforeEach(async () => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    jwtSecret = app.get(ConfigService).get<string>('SECRET') ?? '';
    // Enforce the regular-tier note quota (50): while the rollout is disabled
    // the marketing floor (gold, 500 notes) applies and 49 notes never hit the
    // cap, so no parallel create would be rejected.
    await prisma.membershipProgramState.upsert({
      where: { id: 1 },
      update: { enabledAt: new Date() },
      create: { id: 1, enabledAt: new Date() },
    });
  });

  it('allows exactly one of two parallel creates at limit minus one', async () => {
    const user = await createUser('note-create-race');
    await prisma.note.createMany({
      data: Array.from({ length: 49 }, (_, index) => ({
        ownerID: user.id,
        title: `Existing ${index}`,
      })),
    });
    const token = accessToken(user);

    await expectOneQuotaWinner(user.id, [
      createRequest(token, 'Parallel A'),
      createRequest(token, 'Parallel B'),
    ]);
  });

  it('allows exactly one parallel create or collect at limit minus one', async () => {
    const [user, sourceOwner] = await Promise.all([
      createUser('note-mixed-race'),
      createUser('note-source-owner'),
    ]);
    const source = await prisma.note.create({
      data: {
        ownerID: sourceOwner.id,
        title: 'Shared source',
        available: true,
      },
    });
    await prisma.note.createMany({
      data: Array.from({ length: 49 }, (_, index) => ({
        ownerID: user.id,
        title: `Existing ${index}`,
      })),
    });
    const token = accessToken(user);

    await expectOneQuotaWinner(user.id, [
      createRequest(token, 'Parallel create'),
      request(getE2eApp().getHttpServer())
        .post('/api/v1/note/collect')
        .set('Authorization', `Bearer ${token}`)
        .send({
          noteId: source.id,
          source: {
            conversationType: 'private',
            conversationID: 'quota-race-chat',
            clientMsgID: 'quota-race-message',
            sender: { id: sourceOwner.id, name: sourceOwner.nickname },
          },
        }),
    ]);
  });
});
