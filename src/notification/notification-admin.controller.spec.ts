import { INestApplication, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { NotificationAdminController } from './notification-admin.controller';
import { NotificationService } from './notification.service';

describe('NotificationAdminController', () => {
  const response = { createdCount: 2 };
  const service = {
    publishSystemAnnouncement: jest.fn().mockResolvedValue(response),
  };
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationAdminController],
      providers: [{ provide: NotificationService, useValue: service }],
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
      Reflect.getMetadata(GUARDS_METADATA, NotificationAdminController),
    ).toEqual([JwtGuard, AdminGuard]);
  });

  it('publishes trimmed system announcement content from the authenticated admin', async () => {
    await request(app.getHttpServer())
      .post('/admin/system-announcements')
      .send({ content: '  New app version is available.  ' })
      .expect(201, response);

    expect(service.publishSystemAnnouncement).toHaveBeenCalledWith(
      'admin-1',
      {
        content: 'New app version is available.',
      },
      expect.objectContaining({
        ip: expect.any(String),
        userAgent: null,
      }),
    );
  });

  it.each([
    {},
    { content: '' },
    { content: '   ' },
    { content: 'x'.repeat(5001) },
    { content: 'ok', targetUserId: 'user-1' },
  ])('rejects an invalid announcement DTO: %j', async (body) => {
    await request(app.getHttpServer())
      .post('/admin/system-announcements')
      .send(body)
      .expect(400);
    expect(service.publishSystemAnnouncement).not.toHaveBeenCalled();
  });
});
