import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InvitationListQueryDto } from './circle-invitation.dto';

describe('InvitationListQueryDto', () => {
  it('defaults to 50 and transforms a supplied limit', () => {
    expect(plainToInstance(InvitationListQueryDto, {}).limit).toBe(50);
    expect(
      plainToInstance(InvitationListQueryDto, { limit: '100' }).limit,
    ).toBe(100);
  });

  it.each([0, 101, 1.5])('rejects out-of-range limit %s', async (limit) => {
    const errors = await validate(
      plainToInstance(InvitationListQueryDto, { limit }),
    );
    expect(errors).not.toHaveLength(0);
  });

  it('rejects a malformed cursor', async () => {
    const errors = await validate(
      plainToInstance(InvitationListQueryDto, { cursor: 'not-a-uuid' }),
    );
    expect(errors).not.toHaveLength(0);
  });
});
