import { readFileSync } from 'fs';
import { join } from 'path';
import type { RequestWithUser } from 'src/auth/types';
import { IdempotencyScope } from 'src/idempotency/idempotency.service';
import { CircleController } from './circle.controller';
import type { CreateCircleDto } from './dto/circle.dto';

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

describe('CircleController.create idempotency', () => {
  it('runs the create under its own scope with the raw Idempotency-Key header', async () => {
    const circle = { id: 'circle-1' };
    const circleService = { createCircle: jest.fn().mockResolvedValue(circle) };
    const idempotency = {
      run: jest.fn((_request: unknown, operation: () => Promise<unknown>) =>
        operation(),
      ),
    };
    const controller = new CircleController(
      circleService as never,
      idempotency as never,
    );
    const dto = { name: 'Hiking' } as CreateCircleDto;

    await expect(
      controller.create(
        dto,
        { user: { userId: 'owner-1' } } as RequestWithUser,
        'circle-retry-01',
      ),
    ).resolves.toBe(circle);

    expect(idempotency.run).toHaveBeenCalledWith(
      {
        scope: IdempotencyScope.CircleCreate,
        userId: 'owner-1',
        key: 'circle-retry-01',
        request: dto,
      },
      expect.any(Function),
    );
    expect(circleService.createCircle).toHaveBeenCalledWith('owner-1', dto);
    expect(
      Reflect.getMetadata(
        'swagger/apiParameters',
        CircleController.prototype.create,
      ),
    ).toContainEqual(
      expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
      }),
    );
  });
});
