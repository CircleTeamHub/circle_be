import { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { MembershipProgramAdminController } from './membership-program-admin.controller';
import { MembershipProgramService } from './membership-program.service';

describe('MembershipProgramAdminController', () => {
  const response = {
    replayed: false,
    status: {
      enabled: true,
      enabledAt: '2026-08-01T00:00:00.000Z',
      enabledByUserId: 'admin-1',
      entitlementFloorLevel: 0,
    },
  };
  const service = { enable: jest.fn().mockResolvedValue(response) };
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [MembershipProgramAdminController],
      providers: [{ provide: MembershipProgramService, useValue: service }],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = { userId: 'admin-1' };
          return true;
        },
      })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => app.close());

  it('requires admin authentication and enables the program for the operator', async () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, MembershipProgramAdminController),
    ).toEqual([JwtGuard, AdminGuard]);

    await request(app.getHttpServer())
      .post('/admin/memberships/program/enable')
      .expect(201, response);

    expect(service.enable).toHaveBeenCalledWith('admin-1');
  });
});
