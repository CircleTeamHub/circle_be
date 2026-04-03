import * as pactum from 'pactum';

describe('Auth e2e', () => {
  let spec: ReturnType<typeof pactum.spec>;

  beforeEach(() => {
    spec = global.spec;
  });

  it('register creates user and returns tokens', () => {
    return spec
      .post('/api/v1/auth/register')
      .withBody({
        username: 'testuser1',
        password: 'password1',
        nickname: 'Test User',
      })
      .expectStatus(201)
      .expectJsonLike({
        code: 0,
        message: 'ok',
        data: { accessToken: '', refreshToken: '' },
      });
  });

  it('duplicate registration returns 409', async () => {
    await pactum.spec().post('/api/v1/auth/register').withBody({
      username: 'testuser1',
      password: 'password1',
      nickname: 'Test User',
    });

    return spec
      .post('/api/v1/auth/register')
      .withBody({
        username: 'testuser1',
        password: 'password1',
        nickname: 'Test User',
      })
      .expectStatus(409);
  });

  it('login returns tokens with correct credentials', async () => {
    await pactum.spec().post('/api/v1/auth/register').withBody({
      username: 'testuser1',
      password: 'password1',
      nickname: 'Test User',
    });

    return spec
      .post('/api/v1/auth/login')
      .withBody({ username: 'testuser1', password: 'password1' })
      .expectStatus(201)
      .expectJsonLike({ code: 0, message: 'ok', data: { accessToken: '' } });
  });

  it('login with unknown user returns 403', () => {
    return spec
      .post('/api/v1/auth/login')
      .withBody({ username: 'nobody', password: 'password1' })
      .expectStatus(403);
  });

  it('login with wrong password returns 403', async () => {
    await pactum.spec().post('/api/v1/auth/register').withBody({
      username: 'testuser1',
      password: 'password1',
      nickname: 'Test User',
    });

    return spec
      .post('/api/v1/auth/login')
      .withBody({ username: 'testuser1', password: 'wrongpass' })
      .expectStatus(403);
  });
});
