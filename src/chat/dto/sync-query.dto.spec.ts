import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SYNC_PAGE_MAX } from '../chat.constants';
import { SyncQueryDto } from './sync-query.dto';

async function errorsFor(query: Record<string, unknown>) {
  return validate(plainToInstance(SyncQueryDto, query));
}

describe('SyncQueryDto', () => {
  it('accepts a fresh device starting from zero and a query-string cursor', async () => {
    expect(await errorsFor({ afterRevision: 0 })).toHaveLength(0);
    // 查询串里的数字是字符串,Type(() => Number) 负责转过来。
    expect(await errorsFor({ afterRevision: '42', limit: '50' })).toHaveLength(
      0,
    );
  });

  it('requires a non-negative integer cursor', async () => {
    expect((await errorsFor({})).length).toBeGreaterThan(0);
    expect((await errorsFor({ afterRevision: -1 })).length).toBeGreaterThan(0);
    expect((await errorsFor({ afterRevision: 1.5 })).length).toBeGreaterThan(0);
  });

  it('bounds the page size', async () => {
    expect(
      (await errorsFor({ afterRevision: 0, limit: 0 })).length,
    ).toBeGreaterThan(0);
    expect(
      (await errorsFor({ afterRevision: 0, limit: SYNC_PAGE_MAX + 1 })).length,
    ).toBeGreaterThan(0);
    expect(
      await errorsFor({ afterRevision: 0, limit: SYNC_PAGE_MAX }),
    ).toHaveLength(0);
  });
});
