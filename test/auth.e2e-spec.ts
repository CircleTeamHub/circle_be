import * as pactum from 'pactum';

// Registration is gated behind an email verification code. The CI E2E job
// explicitly opts into EMAIL_CODE_DEV_BYPASS=999999 so the suite can register
// deterministically without minting and reading back a real code. See
// email-verification.service.ts:getDevBypassCode.
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
