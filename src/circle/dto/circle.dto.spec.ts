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

// createCircle 也只把 undefined 当「没传」,@IsOptional() 却连 null 一起跳过,
// 于是 null 会写到非空整型列上变成 500 —— 与 PATCH 那半是两条独立的请求路径。
describe('CreateCircleDto requiredVerifierCount', () => {
  it('rejects an explicit null', () => {
    const dto = plainToInstance(
      CreateCircleDto,
      { requiredVerifierCount: null },
      { enableImplicitConversion: true },
    );

    expect(
      validateSync(dto).some((e) => e.property === 'requiredVerifierCount'),
    ).toBe(true);
  });

  it('still accepts an omitted value and a real count', () => {
    const omitted = plainToInstance(
      CreateCircleDto,
      {},
      { enableImplicitConversion: true },
    );
    expect(
      validateSync(omitted).some((e) => e.property === 'requiredVerifierCount'),
    ).toBe(false);

    const provided = plainToInstance(
      CreateCircleDto,
      { requiredVerifierCount: 10 },
      { enableImplicitConversion: true },
    );
    expect(
      validateSync(provided).some(
        (e) => e.property === 'requiredVerifierCount',
      ),
    ).toBe(false);
  });
});

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

  // 全局 ValidationPipe 开着 enableImplicitConversion,它把任意非空字符串转成
  // true —— 没有 @Transform 读原值的话,`memberCanInvite: "false"` 会被静默当成
  // 「开着」:圈主以为关掉了成员邀请,其实一个都没关。
  it('rejects string booleans instead of silently reading them as true', () => {
    for (const property of [
      'memberCanInvite',
      'memberCanPost',
      'joinFancyRestriction',
    ]) {
      expect(failed({ [property]: 'false' }, property)).toBe(true);
      expect(failed({ [property]: 'true' }, property)).toBe(true);
      expect(failed({ [property]: '0' }, property)).toBe(true);
    }
  });

  it('keeps real booleans working, false included', () => {
    const { dto, errors } = parse({
      memberCanInvite: false,
      memberCanPost: true,
    });

    expect(errors).toHaveLength(0);
    expect(dto.memberCanInvite).toBe(false);
    expect(dto.memberCanPost).toBe(true);
  });

  // 数字字段吃的是 enableImplicitConversion 的另一面:@Type(() => Number) 把
  // false→0、true→1。于是 joinVipRestriction:false 等同「清空限制」,
  // requiredVerifierCount:true 等同 1 —— 把入圈验证整个关掉。
  it('rejects booleans on the numeric admission fields', () => {
    for (const property of [
      'joinVipRestriction',
      'joinCreditRestriction',
      'requiredVerifierCount',
    ]) {
      expect(failed({ [property]: false }, property)).toBe(true);
      expect(failed({ [property]: true }, property)).toBe(true);
    }
  });

  it('still accepts real numbers and the nullable clears', () => {
    const { dto, errors } = parse({
      joinVipRestriction: 3,
      requiredVerifierCount: 10,
      joinCreditRestriction: null,
    });

    expect(errors).toHaveLength(0);
    expect(dto.joinVipRestriction).toBe(3);
    expect(dto.requiredVerifierCount).toBe(10);
    expect(dto.joinCreditRestriction).toBeNull();
  });

  // MINIO_PUBLIC_URL 没配时 assertAvatarUrlIsSafe 直接短路,不设长度上限的话
  // 任意长的字符串会入库,再被圈子列表/详情原样发出去。
  it('bounds the avatar url length', () => {
    expect(failed({ avatarUrl: 'a'.repeat(501) }, 'avatarUrl')).toBe(true);
    expect(parse({ avatarUrl: 'a'.repeat(500) }).errors).toHaveLength(0);
  });

  // PATCH 语义:没传的字段一律不校验、不写。
  it('accepts an empty patch and an empty description', () => {
    expect(parse({}).errors).toHaveLength(0);
    // 自研栈下「群公告即圈子简介」,清空公告是合法操作。
    expect(parse({ description: '' }).errors).toHaveLength(0);
  });
});
