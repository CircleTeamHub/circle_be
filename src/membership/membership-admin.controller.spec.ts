import { INestApplication, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { MembershipAdminController } from './membership-admin.controller';
import { MembershipAdminService } from './membership-admin.service';

describe('MembershipAdminController', () => {
  const operatorId = '10000000-0000-4000-8000-000000000001';
  const targetId = '20000000-0000-4000-8000-000000000002';
  const idempotencyKey = '30000000-0000-4000-8000-000000000003';
  const response = { replayed: false, grant: { id: 'grant-1' } };
  const service = { grant: jest.fn().mockResolvedValue(response) };
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [MembershipAdminController],
      providers: [{ provide: MembershipAdminService, useValue: service }],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = { userId: operatorId };
          return true;
        },
      })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => app.close());

  it('requires ADMIN-audience authentication and authorization', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, MembershipAdminController),
    ).toEqual([JwtGuard, AdminGuard]);
  });

  it('takes the operator only from the authenticated request and trims note', async () => {
    await request(app.getHttpServer())
      .post(`/admin/memberships/users/${targetId}/grants`)
      .send({ targetLevel: 3, idempotencyKey, note: '  approved case  ' })
      .expect(201, response);

    expect(service.grant).toHaveBeenCalledWith(operatorId, targetId, {
      targetLevel: 3,
      idempotencyKey,
      note: 'approved case',
    });
  });

  it.each([
    [{ targetLevel: 0, idempotencyKey }],
    [{ targetLevel: 5, idempotencyKey }],
    [{ targetLevel: 2.5, idempotencyKey }],
    [{ targetLevel: 2, idempotencyKey: 'not-a-uuid' }],
    [{ targetLevel: 2, idempotencyKey, note: 'x'.repeat(501) }],
    [{ targetLevel: 2, idempotencyKey, operatorId }],
  ])('rejects an invalid grant DTO: %j', async (body) => {
    await request(app.getHttpServer())
      .post(`/admin/memberships/users/${targetId}/grants`)
      .send(body)
      .expect(400);
    expect(service.grant).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID target user route parameter', async () => {
    await request(app.getHttpServer())
      .post('/admin/memberships/users/not-a-uuid/grants')
      .send({ targetLevel: 2, idempotencyKey })
      .expect(400);
    expect(service.grant).not.toHaveBeenCalled();
  });
});
