import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtGuard } from 'src/guards/jwt.guard';
import { MembershipController } from './membership.controller';
import { MembershipService } from './membership.service';

describe('MembershipController', () => {
  let app: INestApplication;
  const plans = [1, 2, 3, 4].map((level) => ({
    level,
    name: `VIP${level}`,
    price: level * 100,
    perks: 'test',
  }));
  const service = { getPlans: jest.fn(() => plans) };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MembershipController],
      providers: [{ provide: MembershipService, useValue: service }],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('keeps the four-tier plans read endpoint available', async () => {
    const response = await request(app.getHttpServer())
      .get('/membership/plans')
      .expect(200);

    expect(response.body.map((plan: { level: number }) => plan.level)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('does not expose the unaudited points upgrade writer', async () => {
    await request(app.getHttpServer())
      .post('/membership/upgrade')
      .send({ level: 2 })
      .expect(404);
  });

  it('does not retain an internal upgrade mutation method', () => {
    expect(MembershipService.prototype).not.toHaveProperty('upgrade');
  });
});
