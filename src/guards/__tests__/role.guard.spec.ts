import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleGuard } from '../role.guard';
import { Role } from 'src/enum/roles.enum';

function createContext(user?: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => jest.fn(),
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe('RoleGuard', () => {
  const reflector = {
    getAllAndOverride: jest.fn(),
  } as unknown as Reflector;

  let guard: RoleGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new RoleGuard(reflector);
  });

  it('denies access when a required role is missing', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([Role.Admin]);

    expect(guard.canActivate(createContext({ role: Role.User }))).toBe(false);
    expect(guard.canActivate(createContext())).toBe(false);
  });

  it('allows access when the user has a required role', () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([Role.Admin]);

    expect(guard.canActivate(createContext({ role: Role.Admin }))).toBe(true);
  });
});
