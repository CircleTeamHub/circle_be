import * as pactum from 'pactum';
import { AuthErrorCode } from 'src/common/app-error-codes';

// Registration is gated behind an email verification code. In non-production the
// EmailVerificationService accepts a dev-bypass code (EMAIL_CODE_DEV_BYPASS,
// default '999999'), so e2e can register deterministically without minting and
// reading back a real code. See email-verification.service.ts:getDevBypassCode.
const BYPASS_CODE = '999999';
const EMAIL = 'e2e-user@example.com';
const PASSWORD = 'password1';

const registerBody = (overrides: Record<string, unknown> = {}) => ({
  email: EMAIL,
  code: BYPASS_CODE,
  password: PASSWORD,
  nickname: 'Test User',
  ...overrides,
});

describe('Auth e2e', () => {
  let spec: ReturnType<typeof pactum.spec>;

  beforeEach(() => {
    spec = global.spec;
  });

  it('register creates user and returns tokens', () => {
    return spec
      .post('/api/v1/auth/register')
      .withBody(registerBody())
      .expectStatus(201)
      .expectJsonLike({
        code: 0,
        message: 'ok',
        // Regex asserts a non-empty token without pinning the exact value.
        data: { accessToken: /.+/, refreshToken: /.+/ },
      });
  });

  it('register accepts an invite code and persists the inviter relationship', async () => {
    const inviterTokens = await pactum
      .spec()
      .post('/api/v1/auth/register')
      .withBody(registerBody())
      .expectStatus(201)
      .returns('data');

    const inviter = await pactum
      .spec()
      .get('/api/v1/auth/me')
      .withHeaders('Authorization', `Bearer ${inviterTokens.accessToken}`)
      .expectStatus(200)
      .returns('data');

    expect(inviter.inviteCode).toMatch(/^[a-z0-9]{6}$/);

    await pactum
      .spec()
      .post('/api/v1/auth/register')
      .withBody(
        registerBody({
          email: 'invited-user@example.com',
          inviteCode: `  ${inviter.inviteCode.toUpperCase()}  `,
        }),
      )
      .expectStatus(201);

    const invitedUser = await global.appFactory.database.user.findUnique({
      where: { email: 'invited-user@example.com' },
      select: { invitedByUserId: true },
    });

    expect(invitedUser?.invitedByUserId).toBe(inviter.id);
  });

  it('register rejects an invalid invite code without creating a user', async () => {
    const email = 'invalid-invite@example.com';

    await spec
      .post('/api/v1/auth/register')
      .withBody(registerBody({ email, inviteCode: 'missing1' }))
      .expectStatus(400)
      .expectJsonLike({
        code: 400,
        errorCode: AuthErrorCode.InviteCodeInvalid,
      });

    await expect(
      global.appFactory.database.user.findUnique({ where: { email } }),
    ).resolves.toBeNull();
  });

  it('register rejects an invalid email with 400', () => {
    return spec
      .post('/api/v1/auth/register')
      .withBody(registerBody({ email: 'not-an-email' }))
      .expectStatus(400);
  });

  it('duplicate registration returns 409', async () => {
    await pactum.spec().post('/api/v1/auth/register').withBody(registerBody());

    return spec
      .post('/api/v1/auth/register')
      .withBody(registerBody())
      .expectStatus(409);
  });

  it('login returns tokens with correct credentials', async () => {
    await pactum.spec().post('/api/v1/auth/register').withBody(registerBody());

    return spec
      .post('/api/v1/auth/login')
      .withBody({ email: EMAIL, password: PASSWORD })
      .expectStatus(201)
      .expectJsonLike({ code: 0, message: 'ok', data: { accessToken: /.+/ } });
  });

  it('login with unknown email returns 403', () => {
    return spec
      .post('/api/v1/auth/login')
      .withBody({ email: 'nobody@example.com', password: PASSWORD })
      .expectStatus(403);
  });

  it('login with wrong password returns 403', async () => {
    await pactum.spec().post('/api/v1/auth/register').withBody(registerBody());

    return spec
      .post('/api/v1/auth/login')
      .withBody({ email: EMAIL, password: 'wrongpass' })
      .expectStatus(403);
  });
});
