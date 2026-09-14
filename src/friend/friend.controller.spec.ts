/**
 * FriendController 的路由面契约。
 *
 * 删掉的是没有任何客户端调用的旧入口:
 * - GET /friend/requests/incoming、GET /friend/requests/outgoing —— App 的「新朋友」
 *   收件箱走 GET /friend/activities(收到/发出/通过/拒绝/撤回统一成动态流)。
 * - POST /friend/activities/read-all —— App 只逐条 POST /friend/activities/:id/read。
 * - POST|DELETE /friend/:friendUserId/blacklist —— 与 POST /friend/block、
 *   DELETE /friend/block/:targetId 完全重复,App 只用后者。
 */
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MAX_PAGE } from 'src/common/pagination';
import { JwtGuard } from 'src/guards/jwt.guard';
import { FriendController } from './friend.controller';
import { FriendService } from './friend.service';

const FRIEND_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('FriendController routes', () => {
  let app: INestApplication;
  const friendService = {
    listBlocked: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [FriendController],
      providers: [{ provide: FriendService, useValue: friendService }],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = { userId: 'user-1' };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    ['get', '/friend/requests/incoming'],
    ['get', '/friend/requests/outgoing'],
    ['post', '/friend/activities/read-all'],
    ['post', `/friend/${FRIEND_ID}/blacklist`],
    ['delete', `/friend/${FRIEND_ID}/blacklist`],
  ] as const)('%s %s is gone', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(404);
  });

  it('drops the removed handlers and the service methods only they used', () => {
    const controller = FriendController.prototype as unknown as Record<
      string,
      unknown
    >;
    for (const handler of [
      'listIncoming',
      'listOutgoing',
      'markAllActivitiesRead',
      'blacklistFriend',
      'removeFriendFromBlacklist',
    ]) {
      expect(controller[handler]).toBeUndefined();
    }
    const service = FriendService.prototype as unknown as Record<
      string,
      unknown
    >;
    for (const method of [
      'listIncomingRequests',
      'listOutgoingRequests',
      'markAllActivitiesRead',
    ]) {
      expect(service[method]).toBeUndefined();
    }
  });

  // 页码走 src/common/pagination 的统一上限,不再是控制器里私有的 10_000。
  it('clamps GET /friend/blocked?page to the shared MAX_PAGE', async () => {
    await request(app.getHttpServer())
      .get('/friend/blocked?page=100000000')
      .expect(200);

    expect(friendService.listBlocked).toHaveBeenCalledWith('user-1', MAX_PAGE);
  });

  it('defaults GET /friend/blocked to the first page', async () => {
    await request(app.getHttpServer()).get('/friend/blocked').expect(200);

    expect(friendService.listBlocked).toHaveBeenCalledWith('user-1', 1);
  });
});
