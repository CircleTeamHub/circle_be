import { ExecutionContext } from '@nestjs/common';
import { AdminGuard } from '../admin.guard';
import { Role } from 'src/enum/roles.enum';

function createContext(user?: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  const guard = new AdminGuard();

  it('denies access when the request user is not an admin', () => {
    expect(guard.canActivate(createContext({ role: Role.User }))).toBe(false);
    expect(guard.canActivate(createContext())).toBe(false);
  });

  it('allows access for admin users', () => {
    expect(guard.canActivate(createContext({ role: Role.Admin }))).toBe(true);
  });
});
