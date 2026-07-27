import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtGuard } from 'src/guards/jwt.guard';
import { MembershipController } from './membership.controller';
import { MembershipService } from './membership.service';
import { MembershipProgramService } from './membership-program.service';

describe('MembershipController', () => {
  let app: INestApplication;
  const plans = [1, 2, 3, 4].map((level) => ({ level }));
  const membership = { storedLevel: 3, effectiveLevel: 3, key: 'diamond' };
  const service = {
    getPlans: jest.fn(() => plans),
    getMe: jest.fn().mockResolvedValue(membership),
  };
  const programService = {
    getStatus: jest.fn().mockResolvedValue({
      enabled: false,
      enabledAt: null,
      enabledByUserId: null,
      entitlementFloorLevel: 2,
    }),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MembershipController],
      providers: [
        { provide: MembershipService, useValue: service },
        { provide: MembershipProgramService, useValue: programService },
      ],
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

  it('exposes the disabled marketing status to authenticated clients', async () => {
    await request(app.getHttpServer()).get('/membership/program').expect(200, {
      enabled: false,
      enabledAt: null,
      entitlementFloorLevel: 2,
    });
  });

  it('does not expose the unaudited points upgrade writer', async () => {
    await request(app.getHttpServer())
      .post('/membership/upgrade')
      .send({ level: 2 })
      .expect(404);
  });

  it('returns membership state for the authenticated user', async () => {
    const controller = new MembershipController(
      service as never,
      programService as never,
    ) as any;

    await expect(
      controller.getMe({ user: { userId: 'user-1' } } as never),
    ).resolves.toBe(membership);
    expect(service.getMe).toHaveBeenCalledWith('user-1');
  });

  it('does not retain an internal upgrade mutation method', () => {
    expect(MembershipService.prototype).not.toHaveProperty('upgrade');
  });
});
