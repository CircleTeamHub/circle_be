import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AppearancesDto } from './appearances.dto';

describe('AppearancesDto', () => {
  it('accepts UUID/OpenIM aliases and up to 200 entries', async () => {
    const dto = plainToInstance(AppearancesDto, {
      ids: Array.from({ length: 200 }, (_, index) => `alias-${index}`),
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('rejects more than 200 entries', async () => {
    const dto = plainToInstance(AppearancesDto, {
      ids: Array.from({ length: 201 }, (_, index) => `alias-${index}`),
    });

    expect(await validate(dto)).not.toEqual([]);
  });

  it.each([{}, { ids: [] }, { ids: ['x'.repeat(65)] }, { ids: [42] }])(
    'rejects malformed body %p',
    async (body) => {
      expect(await validate(plainToInstance(AppearancesDto, body))).not.toEqual(
        [],
      );
    },
  );
});
