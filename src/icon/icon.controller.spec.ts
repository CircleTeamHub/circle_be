import type { RequestWithUser } from 'src/auth/types';
import { IconController } from './icon.controller';
import type { IconService } from './icon.service';

/** Compile-time type identity; unlike assignability it tells `any` apart. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

describe('IconController', () => {
  const iconService = {
    getIconOptions: jest.fn(),
    updateDisplayIcons: jest.fn(),
  };
  const controller = new IconController(iconService as unknown as IconService);
  const req = {
    user: { userId: 'user-1', accountId: 'jimmy', role: 'USER' },
  } as RequestWithUser;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scopes both handlers to the authenticated user', async () => {
    await controller.options(req);
    await controller.updateDisplay(req, { items: [] });

    expect(iconService.getIconOptions).toHaveBeenCalledWith('user-1');
    expect(iconService.updateDisplayIcons).toHaveBeenCalledWith('user-1', []);
  });

  // 此前两个 handler 的 req 都是 any。类型钉在 RequestWithUser 上 —— 退回 any 时这里
  // 编译不过。
  it('types every request parameter as RequestWithUser', () => {
    const options: Equals<
      Parameters<IconController['options']>[0],
      RequestWithUser
    > = true;
    const updateDisplay: Equals<
      Parameters<IconController['updateDisplay']>[0],
      RequestWithUser
    > = true;

    expect([options, updateDisplay]).toEqual([true, true]);
  });
});
