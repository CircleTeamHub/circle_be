import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreatePlazaPostDto,
  PlazaFeedQueryDto,
  PlazaFeedSearchDto,
  RecognizePostCollaboratorsDto,
} from './circle-plaza.dto';

describe('CreatePlazaPostDto', () => {
  it.each(['vipRestriction', 'signupVipRestriction'] as const)(
    'accepts zero as the legacy no-restriction value for %s',
    (property) => {
      const dto = plainToInstance(CreatePlazaPostDto, {
        content: 'hello plaza',
        circleId: '07b8cd30-afdf-4b74-8dfe-6dd5b422364b',
        [property]: 0,
      });

      expect(validateSync(dto)).toHaveLength(0);
    },
  );

  it.each(['vipRestriction', 'signupVipRestriction'] as const)(
    'rejects %s above membership level 4',
    (property) => {
      const dto = plainToInstance(CreatePlazaPostDto, {
        content: 'hello plaza',
        circleId: '07b8cd30-afdf-4b74-8dfe-6dd5b422364b',
        [property]: 5,
      });

      const error = validateSync(dto).find(
        (item) => item.property === property,
      );
      expect(error).toHaveProperty('constraints.max');
    },
  );
});

describe('PlazaFeedQueryDto', () => {
  it('accepts existing circle ids that are not RFC UUID variants', () => {
    const dto = plainToInstance(PlazaFeedQueryDto, {
      circleId: '07b8cd30-afdf-3b74-5dfe-6dd5b422364b',
    });

    expect(validateSync(dto)).toHaveLength(0);
  });
});

describe('PlazaFeedSearchDto', () => {
  it('accepts 1000 city filters without truncation', () => {
    const cities = Array.from({ length: 1000 }, (_, index) => `city-${index}`);
    const dto = plainToInstance(PlazaFeedSearchDto, { cities });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.cities).toEqual(cities);
  });

  it('rejects 1001 city filters', () => {
    const dto = plainToInstance(PlazaFeedSearchDto, {
      cities: Array.from({ length: 1001 }, (_, index) => `city-${index}`),
    });

    const error = validateSync(dto).find((item) => item.property === 'cities');
    expect(error).toHaveProperty('constraints.arrayMaxSize');
  });

  it('rejects an overlong city name', () => {
    const dto = plainToInstance(PlazaFeedSearchDto, {
      cities: ['x'.repeat(101)],
    });

    const error = validateSync(dto).find((item) => item.property === 'cities');
    expect(error).toHaveProperty('constraints.maxLength');
  });
});

describe('RecognizePostCollaboratorsDto', () => {
  it('accepts existing user ids that are not RFC UUID v4 variants', () => {
    const dto = plainToInstance(RecognizePostCollaboratorsDto, {
      recipientIds: ['131ac074-269b-ea96-db45-1de71ab521d6'],
    });

    expect(validateSync(dto)).toHaveLength(0);
  });
});
