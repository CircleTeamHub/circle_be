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
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { MAX_PAGE } from 'src/common/pagination';
import { JwtGuard } from 'src/guards/jwt.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import { FriendController } from './friend.controller';
import { FriendService } from './friend.service';

const FRIEND_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('FriendController routes', () => {
  let app: INestApplication;
  const friendService = {
    listBlocked: jest.fn().mockResolvedValue([]),
    setFriendPermission: jest.fn().mockResolvedValue(undefined),
    sendRequest: jest.fn().mockResolvedValue(undefined),
  };
  // 当前登录用户;按账号限流的用例会切换它。
  let currentUserId = 'user-1';

  beforeEach(async () => {
    jest.clearAllMocks();
    currentUserId = 'user-1';
    const moduleRef = await Test.createTestingModule({
      // 与 app.module 一致:ThrottlerModule 全局注册,路由按需挂 UserThrottlerGuard。
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
      ],
      controllers: [FriendController],
      providers: [{ provide: FriendService, useValue: friendService }],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = { userId: currentUserId };
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

  // 好友申请会给对方推通知、写动态,不限流的话一个账号能对全站刷屏。
  // 阈值:每个账号 10 分钟 20 次(产品可调,见 friend.controller.ts)。
  it('throttles POST /friend/requests per account at 20 per 10 minutes', () => {
    const handler = FriendController.prototype.sendRequest;

    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
      UserThrottlerGuard,
    );
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(20);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(
      10 * 60_000,
    );
  });

  it('answers the 21st friend request in the window with 429, counted per account', async () => {
    const send = () =>
      request(app.getHttpServer())
        .post('/friend/requests')
        .send({ targetId: FRIEND_ID });

    for (let i = 0; i < 20; i += 1) {
      await send().expect(204);
    }
    await send().expect(429);
    expect(friendService.sendRequest).toHaveBeenCalledTimes(20);

    // 额度按账号算:同一出口的另一个账号不受影响。
    currentUserId = 'user-2';
    await send().expect(204);
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

  it('PATCH /friend/:friendUserId/permission delegates the current user and body', async () => {
    await request(app.getHttpServer())
      .patch(`/friend/${FRIEND_ID}/permission`)
      .send({ permission: 'CHAT_ONLY' })
      .expect(204);

    expect(friendService.setFriendPermission).toHaveBeenCalledWith(
      'user-1',
      FRIEND_ID,
      'CHAT_ONLY',
    );
  });

  it.each([
    'aabbccdd-1122-0000-0000-123456789abc',
    'AABBCCDD-1122-0000-0000-123456789ABC',
    'aabbccdd112200000000123456789abc',
  ])(
    'accepts persisted or legacy user ID %s on the permission route',
    async (id) => {
      await request(app.getHttpServer())
        .patch(`/friend/${id}/permission`)
        .send({ permission: 'FULL' })
        .expect(204);
      expect(friendService.setFriendPermission).toHaveBeenCalledWith(
        'user-1',
        'aabbccdd-1122-0000-0000-123456789abc',
        'FULL',
      );
    },
  );
});
