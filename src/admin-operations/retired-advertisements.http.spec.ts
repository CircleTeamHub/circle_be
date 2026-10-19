import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AdminOperationsController } from './admin-operations.controller';
import { AdminAuditQueryService } from './admin-audit-query.service';
import { AdminInviteService } from './admin-invite.service';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminGuard } from 'src/guards/admin.guard';
import { AdminPermissionGuard } from 'src/admin-access/admin-permission.guard';

describe('retired advertisement endpoints', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const builder = Test.createTestingModule({
      controllers: [AdminOperationsController],
      providers: [
        {
          provide: AdminAuditQueryService,
          useValue: { list: () => ({ items: [], total: 0 }) },
        },
        {
          provide: AdminInviteService,
          useValue: { campaigns: () => ({ items: [], total: 0 }) },
        },
      ],
    });
    for (const guard of [JwtGuard, AdminGuard, AdminPermissionGuard])
      builder.overrideGuard(guard).useValue({ canActivate: () => true });
    app = (await builder.compile()).createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  it.each([
    ['get', '/advertisements'],
    ['get', '/admin/operations/advertisements'],
    ['post', '/admin/operations/advertisements'],
    [
      'patch',
      '/admin/operations/advertisements/11111111-1111-4111-8111-111111111111',
    ],
  ])('removes %s %s', async (method, path) => {
    const agent = request(app.getHttpServer());
    await agent[method as 'get'](path).expect(404);
  });
  it('preserves other operations routes', async () => {
    await request(app.getHttpServer())
      .get('/admin/operations/audit-logs')
      .expect(200);
    await request(app.getHttpServer())
      .get('/admin/operations/campaign-invites')
      .expect(200);
  });
});
