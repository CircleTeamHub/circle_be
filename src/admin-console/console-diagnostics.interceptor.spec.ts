import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { firstValueFrom, throwError } from 'rxjs';
import { ConsoleDiagnosticsInterceptor } from './console-diagnostics.interceptor';
import type { PrismaService } from 'src/prisma/prisma.service';
import { runWithRequestContext } from 'src/logging/request-context';
it('persists only static diagnostic fields and rethrows the original failure', async () => {
  const create = jest.fn().mockResolvedValue({});
  const interceptor = new ConsoleDiagnosticsInterceptor({
    adminAuditLog: { create },
  } as unknown as PrismaService);
  const request = {
    user: { userId: 'admin', role: 'ADMIN', audience: 'ADMIN' },
    method: 'POST',
    route: { path: '/admin/console/push/:id/retry' },
    body: { password: 'do not record' },
    url: '/admin/console?token=private',
  };
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const error = new BadRequestException('secret contents');
  await expect(
    runWithRequestContext(
      {
        requestId: 'diagnostic',
        traceId: 'trace',
        method: 'POST',
        path: '/admin',
      },
      () =>
        firstValueFrom(
          interceptor.intercept(context, {
            handle: () => throwError(() => error),
          }),
        ),
    ),
  ).rejects.toBe(error);
  expect(create).toHaveBeenCalledWith({
    data: {
      actorID: 'admin',
      action: 'console.request.failed',
      entityType: 'http_request',
      requestId: 'diagnostic',
      metadata: {
        status: 400,
        failureCause: 'INPUT_INVALID',
        method: 'POST',
        route: '/admin/console/push/:id/retry',
      },
    },
  });
  expect(JSON.stringify(create.mock.calls)).not.toMatch(
    /do not record|private|secret contents/,
  );
});
it('does not persist App failures in administrator audit', async () => {
  const create = jest.fn();
  const interceptor = new ConsoleDiagnosticsInterceptor({
    adminAuditLog: { create },
  } as unknown as PrismaService);
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ user: { role: 'USER', audience: 'APP' } }),
    }),
  } as unknown as ExecutionContext;
  await expect(
    firstValueFrom(
      interceptor.intercept(context, {
        handle: () => throwError(() => new Error('fail')),
      }),
    ),
  ).rejects.toThrow('fail');
  expect(create).not.toHaveBeenCalled();
});
