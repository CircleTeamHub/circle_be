import { ParseUUIDPipe } from '@nestjs/common';
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppAudienceGuard } from 'src/guards/app-audience.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { CallController } from './call.controller';
import { IdempotencyScope } from 'src/idempotency/idempotency.service';

describe('CallController', () => {
  it('requires authentication and throttling', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, CallController);
    const createGroup = CallController.prototype.createGroupCall;

    // AppAudienceGuard:通话与聊天同属消费端通信能力,管理台的 ADMIN token
    // 同样能过 JwtGuard,却没有任何通话 UI —— 不该能发起或接听。
    expect(guards).toEqual([ThrottlerGuard, JwtGuard, AppAudienceGuard]);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', createGroup)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', createGroup)).toBe(
      60_000,
    );
  });

  it('passes group call creation through with the current user', async () => {
    const service = {
      createGroupCall: jest.fn().mockResolvedValue({ id: 'call-1' }),
    };
    const controller = new CallController(service as any, {} as any);

    await controller.createGroupCall(
      {
        conversationID: 'sg_group-1',
        callType: 'AUDIO',
        inviteeIDs: ['user-2'],
      },
      { user: { userId: 'user-1' } } as any,
      'request-1',
    );

    expect(service.createGroupCall).toHaveBeenCalledWith(
      'user-1',
      {
        conversationID: 'sg_group-1',
        callType: 'AUDIO',
        inviteeIDs: ['user-2'],
      },
      'request-1',
    );
  });

  it('passes accept, reject, leave, cancel, and join-token calls through', async () => {
    const service = {
      acceptCall: jest.fn().mockResolvedValue({}),
      rejectCall: jest.fn().mockResolvedValue({}),
      leaveCall: jest.fn().mockResolvedValue({}),
      cancelCall: jest.fn().mockResolvedValue({}),
      createJoinToken: jest.fn().mockResolvedValue({}),
    };
    const controller = new CallController(service as any, {} as any);
    const req = { user: { userId: 'user-2' } } as any;

    await controller.acceptCall('call-1', req);
    await controller.rejectCall('call-1', req);
    await controller.leaveCall('call-1', req);
    await controller.cancelCall('call-1', req);
    await controller.createJoinToken('call-1', req);

    expect(service.acceptCall).toHaveBeenCalledWith(
      'user-2',
      'call-1',
      undefined,
    );
    expect(service.rejectCall).toHaveBeenCalledWith(
      'user-2',
      'call-1',
      undefined,
    );
    expect(service.leaveCall).toHaveBeenCalledWith('user-2', 'call-1');
    expect(service.cancelCall).toHaveBeenCalledWith('user-2', 'call-1');
    expect(service.createJoinToken).toHaveBeenCalledWith('user-2', 'call-1');
  });

  // 挂断是通话里最不能失败的一步:挂不断的那一方会把通话卡在 ACTIVE。所以这条路由
  // 不声明 @Body() —— 全局 ValidationPipe 只校验被装饰器登记过的参数,没有 body 参数
  // 就没有 body 校验,forbidNonWhitelisted 也就打不到旧客户端多发的任何字段上
  // (历史上是 reason)。谁把 @Body() 加回来,旧安装包的挂断就会被拒成 400。
  it('leaveCall takes only the call id and the request', () => {
    const paramTypesOf = (handler: 'leaveCall' | 'cancelCall') =>
      Object.keys(
        (Reflect.getMetadata(ROUTE_ARGS_METADATA, CallController, handler) ??
          {}) as Record<string, unknown>,
      )
        // key 形如 `<RouteParamtypes>:<参数下标>`,取前半段即参数种类。
        .map((key) => key.split(':')[0])
        .sort((a, b) => a.localeCompare(b));

    expect(paramTypesOf('leaveCall')).toEqual(paramTypesOf('cancelCall'));
    expect(CallController.prototype.leaveCall).toHaveLength(2);
  });

  it.each(['acceptCall', 'rejectCall'] as const)(
    'validates the optional invitation timestamp before %s',
    async (action) => {
      const service = { [action]: jest.fn().mockResolvedValue({}) };
      const controller = new CallController(service as any, {} as any);
      const request = { user: { userId: 'user-2' } } as any;
      expect(() =>
        controller[action]('call-1', request, 'not-a-timestamp'),
      ).toThrow('Invalid call invitation timestamp');
      expect(service[action]).not.toHaveBeenCalled();
      await controller[action]('call-1', request, '2026-11-10T18:00:00.123Z');
      expect(service[action]).toHaveBeenCalledWith(
        'user-2',
        'call-1',
        new Date('2026-11-10T18:00:00.123Z'),
      );
    },
  );

  // CallSession.id 只由 startCall 的 randomUUID() 生成:非 uuid 的 callId 不可能命中
  // 任何通话,在参数层拒掉,不为它打库。
  it.each([
    'acceptCall',
    'rejectCall',
    'leaveCall',
    'cancelCall',
    'createJoinToken',
    'inviteParticipants',
  ] as const)('%s parses callId as a uuid', (handler) => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      CallController,
      handler,
    ) as Record<string, { data?: unknown; pipes?: unknown[] }>;
    const callIdArg = Object.values(args).find((arg) => arg.data === 'callId');

    expect(callIdArg?.pipes).toContain(ParseUUIDPipe);
  });

  it('scopes invitation replays by actor, call and validated request', async () => {
    const dto = { inviteeIDs: ['user-3'] };
    const response = { call: { id: 'call-1' } };
    const service = {
      inviteParticipants: jest.fn().mockResolvedValue(response),
    };
    const idempotency = {
      run: jest.fn(async (_request, operation) => operation()),
    };
    const controller = new CallController(service as any, idempotency as any);
    await expect(
      controller.inviteParticipants(
        'call-1',
        dto,
        { user: { userId: 'user-1' } } as any,
        'retry_key-0001',
      ),
    ).resolves.toEqual(response);
    expect(idempotency.run).toHaveBeenCalledWith(
      {
        scope: IdempotencyScope.CallInvite,
        userId: 'user-1',
        key: 'retry_key-0001',
        request: { callId: 'call-1', ...dto },
      },
      expect.any(Function),
    );
    expect(service.inviteParticipants).toHaveBeenCalledWith(
      'user-1',
      'call-1',
      dto,
    );
    expect(
      Reflect.getMetadata(
        'THROTTLER:LIMITdefault',
        CallController.prototype.inviteParticipants,
      ),
    ).toBe(10);
  });
});
