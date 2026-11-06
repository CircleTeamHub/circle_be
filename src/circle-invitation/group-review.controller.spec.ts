import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  GroupReviewActionDto,
  GroupReviewQueryDto,
} from './group-review.controller';

const id = '11111111-1111-4111-8111-111111111111';
describe('manager review input', () => {
  it('accepts a bounded list and the explicit blacklist action', async () => {
    expect(
      await validate(
        plainToInstance(GroupReviewActionDto, {
          ids: [id],
          action: 'blacklist',
        }),
      ),
    ).toHaveLength(0);
  });
  it.each([
    { ids: [], action: 'approve' },
    { ids: [id, id], action: 'approve' },
    { ids: ['foreign'], action: 'reject' },
    { ids: [id], action: 'accept' },
    {
      ids: Array.from(
        { length: 51 },
        (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
      ),
      action: 'approve',
    },
  ])('rejects malformed, duplicate or oversized decisions', async (body) => {
    expect(
      (await validate(plainToInstance(GroupReviewActionDto, body))).length,
    ).toBeGreaterThan(0);
  });
  it.each([{ keyword: 'x'.repeat(65) }, { limit: 51 }, { cursor: 'invalid' }])(
    'rejects unbounded or malformed search queries',
    async (query) => {
      expect(
        (await validate(plainToInstance(GroupReviewQueryDto, query))).length,
      ).toBeGreaterThan(0);
    },
  );
});
