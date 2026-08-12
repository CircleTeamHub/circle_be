import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { SupportAdminController } from './support-admin.controller';
import { SupportService } from './support.service';

/**
 * 覆盖式写入的审计能不能被读回来 —— 只在 service 层断言 listForTarget 的入参是不够的:
 * 上一版真正的缺口就在路由层(哨兵目标 id 根本没有任何 HTTP 路径能命中)。
 */
describe('SupportAdminController HTTP pipeline', () => {
  let app: INestApplication;
  const support = {
    listForAdminWithRevision: jest.fn(),
    replaceAgents: jest.fn(),
    listAuditLogs: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    support.listAuditLogs.mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      controllers: [SupportAdminController],
      providers: [{ provide: SupportService, useValue: support }],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp(): {
            getRequest(): { user?: { userId: string; accountId: string } };
          };
        }) => {
          context.switchToHttp().getRequest().user = {
            userId: 'admin-1',
            accountId: 'admin-account',
          };
          return true;
        },
      })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves a replacement record back over HTTP', async () => {
    const record = {
      id: 'audit-1',
      action: 'support.agents.replace',
      actorId: 'admin-1',
      actorAccountId: 'admin-account',
      targetType: 'support_agents',
      targetId: 'all',
      before: [],
      after: [
        { category: 'recharge', userID: 'u1', sortOrder: 0, enabled: true },
      ],
    };
    support.listAuditLogs.mockResolvedValue([record]);

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/support/agents/audit-logs')
      .expect(200);

    expect(response.body).toEqual([record]);
  });

  // 没有 limit 时必须落到一个有界的默认页,而不是把整张审计表拉出来。
  it('defaults the page size when limit is omitted', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/support/agents/audit-logs')
      .expect(200);

    expect(support.listAuditLogs).toHaveBeenCalledWith(20);
  });

  it('passes an explicit limit through as a number', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/support/agents/audit-logs?limit=5')
      .expect(200);

    expect(support.listAuditLogs).toHaveBeenCalledWith(5);
  });

  // 全局 ValidationPipe 开着 enableImplicitConversion,`limit=all` 会先变成 NaN;
  // 服务层不能拿着 NaN 去 take。这里跟 /admin/users/:id/audit-logs 行为保持一致:
  // 回落到有界默认页,而不是 400,也不是把 NaN 传下去。
  it('falls back to the default page size for a non-numeric limit', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/support/agents/audit-logs?limit=all')
      .expect(200);

    expect(support.listAuditLogs).toHaveBeenCalledWith(20);
  });

  // /agents 与 /agents/audit-logs 是两条独立的路由,别让前者把后者吃掉。
  it('keeps the agents listing on its own route', async () => {
    support.listForAdminWithRevision.mockResolvedValue({
      agents: [],
      revision: 'rev-1',
    });

    const response = await request(app.getHttpServer())
      .get('/api/v1/admin/support/agents')
      .expect(200);

    expect(response.body).toEqual({ agents: [], revision: 'rev-1' });
    expect(support.listAuditLogs).not.toHaveBeenCalled();
  });
});
