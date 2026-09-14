import type { RequestWithUser } from 'src/auth/types';
import { CollectionController } from './collection.controller';
import type { CollectionService } from './collection.service';
import type { CreateCollectionDto } from './dto/collection.dto';

/** Compile-time type identity; unlike assignability it tells `any` apart. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

describe('CollectionController', () => {
  const service = { list: jest.fn(), create: jest.fn(), remove: jest.fn() };
  const controller = new CollectionController(
    service as unknown as CollectionService,
  );
  const req = {
    user: { userId: 'user-1', accountId: 'jimmy', role: 'USER' },
  } as RequestWithUser;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scopes every handler to the authenticated user', async () => {
    const dto = { type: 'MESSAGE', title: '收藏' } as CreateCollectionDto;

    await controller.list({}, req);
    await controller.create(dto, req);
    await controller.remove('collection-1', req);

    expect(service.list).toHaveBeenCalledWith('user-1', undefined);
    expect(service.create).toHaveBeenCalledWith('user-1', dto);
    expect(service.remove).toHaveBeenCalledWith('user-1', 'collection-1');
  });

  // 此前三个 handler 的 req 都是 any：写成 req.user.id 之类的错字照样编译通过，运行时
  // 才拿着 undefined 去查库。类型钉在 RequestWithUser 上 —— 退回 any 时这里编译不过。
  it('types every request parameter as RequestWithUser', () => {
    const list: Equals<
      Parameters<CollectionController['list']>[1],
      RequestWithUser
    > = true;
    const create: Equals<
      Parameters<CollectionController['create']>[1],
      RequestWithUser
    > = true;
    const remove: Equals<
      Parameters<CollectionController['remove']>[1],
      RequestWithUser
    > = true;

    expect([list, create, remove]).toEqual([true, true, true]);
  });
});
