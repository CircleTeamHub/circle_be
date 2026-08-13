import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateCircleDto, UpdateCircleDto } from './circle.dto';

describe('CreateCircleDto join VIP restriction caps at the top tier (4)', () => {
  const hasJoinVipError = (payload: Record<string, unknown>) =>
    validateSync(plainToInstance(CreateCircleDto, payload)).some(
      (e) => e.property === 'joinVipRestriction',
    );

  it('rejects a join VIP restriction above super (4)', () => {
    expect(hasJoinVipError({ joinVipRestriction: 5 })).toBe(true);
  });

  it('accepts a join VIP restriction at the top tier (4)', () => {
    expect(hasJoinVipError({ joinVipRestriction: 4 })).toBe(false);
  });
});

// 与 setup.ts 的全局 ValidationPipe 同配置,否则测的不是线上那条路径。
function parse(payload: Record<string, unknown>) {
  const dto = plainToInstance(UpdateCircleDto, payload, {
    enableImplicitConversion: true,
  });
  return { dto, errors: validateSync(dto) };
}

function failed(payload: Record<string, unknown>, property: string) {
  return parse(payload).errors.some((error) => error.property === property);
}

describe('UpdateCircleDto', () => {
  // @IsOptional() 对 undefined 和 null 一视同仁地跳过校验,而 updateCircle 只把
  // undefined 当「没传」—— 于是 null 会一路走到 normalizeStringList().map 或者
  // Prisma 的非空列上,把一个本该 400 的请求变成 500。
  it('rejects an explicit null on fields that are not nullable', () => {
    expect(failed({ name: null }, 'name')).toBe(true);
    expect(failed({ categories: null }, 'categories')).toBe(true);
    expect(failed({ description: null }, 'description')).toBe(true);
    expect(failed({ cities: null }, 'cities')).toBe(true);
    expect(failed({ rules: null }, 'rules')).toBe(true);
    expect(failed({ tags: null }, 'tags')).toBe(true);
    expect(failed({ avatarUrl: null }, 'avatarUrl')).toBe(true);
    expect(failed({ memberCanPost: null }, 'memberCanPost')).toBe(true);
    expect(failed({ memberCanInvite: null }, 'memberCanInvite')).toBe(true);
    expect(failed({ joinFancyRestriction: null }, 'joinFancyRestriction')).toBe(
      true,
    );
    expect(
      failed({ requiredVerifierCount: null }, 'requiredVerifierCount'),
    ).toBe(true);
  });

  // 这两个的 null 是有语义的:落成「无限制」。
  it('keeps null legal on the two restriction fields', () => {
    expect(
      parse({ joinVipRestriction: null, joinCreditRestriction: null }).errors,
    ).toHaveLength(0);
  });

  // @IsNotEmpty() 放行纯空白,于是圈子和它的群会话会顶着一个看不见的名字。
  it('rejects a whitespace-only name', () => {
    expect(failed({ name: '   ' }, 'name')).toBe(true);
    expect(failed({ name: ' \t\n ' }, 'name')).toBe(true);
    // 只有一个字符的名字仍然过不了 MinLength(2)。
    expect(failed({ name: '  圈  ' }, 'name')).toBe(true);
  });

  it('trims a padded name instead of storing the padding', () => {
    const { dto, errors } = parse({ name: '  周末露营  ' });

    expect(errors).toHaveLength(0);
    expect(dto.name).toBe('周末露营');
  });

  // PATCH 语义:没传的字段一律不校验、不写。
  it('accepts an empty patch and an empty description', () => {
    expect(parse({}).errors).toHaveLength(0);
    // 自研栈下「群公告即圈子简介」,清空公告是合法操作。
    expect(parse({ description: '' }).errors).toHaveLength(0);
  });
});
