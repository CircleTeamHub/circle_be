import * as pactum from 'pactum';

describe('App e2e', () => {
  it('unknown route returns 404', () => {
    return pactum.spec().get('/api/v1/nonexistent').expectStatus(404);
  });

  it('POST /api/v1/auth/register with missing body returns 400', () => {
    return pactum
      .spec()
      .post('/api/v1/auth/register')
      .withBody({})
      .expectStatus(400);
  });
});
