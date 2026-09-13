import { existsSync } from 'fs';
import { join } from 'path';

// RoleGuard + @Roles(以及同一批 CASL 风格的 @CheckPolicies / @Can / @Cannot)从未挂到
// 任何路由上:管理端点统一走 JwtGuard + AdminGuard。留着一套「看起来能用」的角色守卫,
// 只会诱导以后的端点接上它 —— 而它只比对 request.user.role,不走管理会话模型。
describe('legacy role-based authorization helpers', () => {
  it.each([
    'src/guards/role.guard.ts',
    'src/decorators/roles.decorator.ts',
    'src/decorators/casl.decorator.ts',
  ])('%s is removed', (file) => {
    expect(existsSync(join(process.cwd(), file))).toBe(false);
  });
});
