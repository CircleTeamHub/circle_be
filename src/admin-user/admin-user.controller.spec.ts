import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { UserRole, UserStatus } from 'src/generated/prisma';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminUserController } from './admin-user.controller';

describe('AdminUserController', () => {
  const service = {
    listUsers: jest.fn(),
    getUserDetail: jest.fn(),
    revealSensitiveField: jest.fn(),
    updateStatus: jest.fn(),
    listAuditLogs: jest.fn(),
  };
  const controller = new AdminUserController(service as never);
  const request = {
    user: {
      userId: 'admin-1',
      accountId: 'support-admin',
      role: 'ADMIN',
      audience: 'ADMIN',
    },
  } as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires both JWT and Admin guards at the controller boundary', () => {
    expect(Reflect.getMetadata('__guards__', AdminUserController)).toEqual([
      JwtGuard,
      AdminGuard,
    ]);
  });

  it.each(['detail', 'reveal', 'updateStatus', 'auditLogs'])(
    'parses %s user IDs as UUIDs',
    (methodName) => {
      const metadata = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        AdminUserController,
        methodName,
      );
      const pipes = Object.values(metadata).flatMap(
        (entry: { pipes?: unknown[] }) => entry.pipes ?? [],
      );
      expect(pipes).toContain(ParseUUIDPipe);
    },
  );

  it('delegates list and detail reads', () => {
    const query = {
      keyword: 'jim',
      role: UserRole.USER,
      page: 1,
      limit: 20,
    };

    controller.list(query);
    controller.detail('11111111-1111-4111-8111-111111111111');

    expect(service.listUsers).toHaveBeenCalledWith(query);
    expect(service.getUserDetail).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('delegates sensitive access with the minimal actor identity', () => {
    const dto = { field: 'email' as const, reason: 'support-123' };

    controller.reveal(
      '11111111-1111-4111-8111-111111111111',
      dto,
      request,
    );

    expect(service.revealSensitiveField).toHaveBeenCalledWith(
      { userId: 'admin-1', accountId: 'support-admin' },
      '11111111-1111-4111-8111-111111111111',
      dto,
    );
  });

  it('delegates status changes with the minimal actor identity', () => {
    const dto = { status: UserStatus.BANNED, reason: 'policy violation' };

    controller.updateStatus(
      '11111111-1111-4111-8111-111111111111',
      dto,
      request,
    );

    expect(service.updateStatus).toHaveBeenCalledWith(
      { userId: 'admin-1', accountId: 'support-admin' },
      '11111111-1111-4111-8111-111111111111',
      dto,
    );
  });

  it('delegates bounded audit history reads', () => {
    controller.auditLogs('11111111-1111-4111-8111-111111111111', 20);

    expect(service.listAuditLogs).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      20,
    );
  });
});
