import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreatePlazaPostDto,
  PlazaFeedQueryDto,
  PlazaFeedSearchDto,
  RecognizePostCollaboratorsDto,
} from './circle-plaza.dto';
import { CreateCircleDto } from '../../circle/dto/circle.dto';

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

describe('CreatePlazaPostDto VIP restrictions cap at the top tier (4)', () => {
  const hasError = (payload: Record<string, unknown>, property: string) =>
    validateSync(plainToInstance(CreatePlazaPostDto, payload)).some(
      (e) => e.property === property,
    );

  it('rejects a join/interaction VIP restriction above super (4)', () => {
    expect(hasError({ vipRestriction: 5 }, 'vipRestriction')).toBe(true);
  });

  it('rejects a signup VIP restriction above super (4)', () => {
    expect(hasError({ signupVipRestriction: 5 }, 'signupVipRestriction')).toBe(
      true,
    );
  });

  it('accepts VIP restrictions at the top tier (4)', () => {
    expect(hasError({ vipRestriction: 4 }, 'vipRestriction')).toBe(false);
    expect(hasError({ signupVipRestriction: 4 }, 'signupVipRestriction')).toBe(
      false,
    );
  });
});

describe('VIP restriction fields advertise the 0..4 cap in OpenAPI metadata', () => {
  // @Max(4) 只做运行时校验;若不同时写进 @ApiPropertyOptional 的 minimum/maximum,
  // 生成的 Swagger 契约里就看不到四档上限,客户端无从适配、会继续发 5+ 请求吃 400。
  // @nestjs/swagger 把 @ApiProperty 选项存在 'swagger/apiModelProperties' 元数据键下。
  const apiMeta = (proto: object, prop: string): Record<string, unknown> =>
    (Reflect.getMetadata('swagger/apiModelProperties', proto, prop) as
      | Record<string, unknown>
      | undefined) ?? {};

  it('CreatePlazaPostDto vip/signup restrictions expose minimum 0 and maximum 4', () => {
    for (const prop of ['vipRestriction', 'signupVipRestriction']) {
      const meta = apiMeta(CreatePlazaPostDto.prototype, prop);
      expect(meta.minimum).toBe(0);
      expect(meta.maximum).toBe(4);
    }
  });

  it('CreateCircleDto joinVipRestriction exposes minimum 0 and maximum 4', () => {
    const meta = apiMeta(CreateCircleDto.prototype, 'joinVipRestriction');
    expect(meta.minimum).toBe(0);
    expect(meta.maximum).toBe(4);
  });
});
