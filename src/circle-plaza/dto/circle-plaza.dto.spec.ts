import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreatePlazaPostDto,
  PlazaFeedQueryDto,
  RecognizePostCollaboratorsDto,
} from './circle-plaza.dto';

describe('PlazaFeedQueryDto', () => {
  it('accepts existing circle ids that are not RFC UUID variants', () => {
    const dto = plainToInstance(PlazaFeedQueryDto, {
      circleId: '07b8cd30-afdf-3b74-5dfe-6dd5b422364b',
    });

    expect(validateSync(dto)).toHaveLength(0);
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
