import { readFileSync } from 'fs';
import { join } from 'path';

// 圈子图标的两条路由曾用 `@Req() req: any` 取当前用户,绕开了 RequestWithUser 的
// 类型约束(req.user.userId 拼错也能编译通过)。与控制器其余路由保持同一类型。
describe('CircleController request typing', () => {
  it('types every @Req() parameter as RequestWithUser', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/circle/circle.controller.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/@Req\(\)\s+req:\s*any\b/);
  });
});
