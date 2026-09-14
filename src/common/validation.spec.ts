import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  validateSync,
  type ValidationError,
} from 'class-validator';
import { IsOptionalNotNull, MaxJsonLength } from './validation';

class NotNullProbe {
  @IsOptionalNotNull()
  @IsBoolean()
  flag?: boolean;

  @IsOptionalNotNull()
  @IsIn(['ALL', 'NONE'])
  mode?: string;
}

class OptionalProbe {
  @IsOptional()
  @IsBoolean()
  flag?: boolean;
}

// 与全局 ValidationPipe 同一组选项（src/setup.ts）。隐式转换对 null 原样放行，
// 所以 null 在这里和线上一样是「真的 null」。
function errorsFor<T extends object>(
  dto: new () => T,
  input: Record<string, unknown>,
): ValidationError[] {
  return validateSync(
    plainToInstance(dto, input, { enableImplicitConversion: true }),
    { whitelist: true, forbidNonWhitelisted: true },
  );
}

describe('IsOptionalNotNull', () => {
  // @IsOptional 把 null 与 undefined 一视同仁地跳过校验：对非空列来说，
  // { "flag": null } 过了管道，落到 Prisma 才炸成 PrismaClientValidationError → 500。
  it('exists because @IsOptional lets an explicit null skip validation', () => {
    expect(errorsFor(OptionalProbe, { flag: null })).toHaveLength(0);
  });

  it('lets an omitted or undefined property through, like @IsOptional', () => {
    expect(errorsFor(NotNullProbe, {})).toHaveLength(0);
    expect(
      errorsFor(NotNullProbe, { flag: undefined, mode: undefined }),
    ).toHaveLength(0);
  });

  it('rejects an explicit null with an isDefined error', () => {
    const errors = errorsFor(NotNullProbe, { flag: null, mode: null });

    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error.constraints).toHaveProperty('isDefined');
    }
  });

  it('validates a present value with the remaining validators as usual', () => {
    expect(errorsFor(NotNullProbe, { flag: true, mode: 'ALL' })).toHaveLength(
      0,
    );

    const [error] = errorsFor(NotNullProbe, { mode: 'SOME' });
    expect(error.property).toBe('mode');
    expect(error.constraints).toHaveProperty('isIn');
    expect(error.constraints).not.toHaveProperty('isDefined');
  });
});

class JsonProbe {
  @IsOptional()
  @MaxJsonLength(20)
  payload?: unknown;
}

// 自由形状的 JSON 属性（如收藏的 payload）只有 @IsObject，大小不设防：一条请求就能往
// 一行 JSONB 里塞进任意大的文档。上限按 JSON.stringify 之后的长度算（UTF-16 码元，
// 与 String#length、聊天正文上限同一把尺子）。
describe('MaxJsonLength', () => {
  it('accepts JSON up to the limit and rejects one character more', () => {
    // {"a":"xxxxxxxxxxxx"} is exactly 20 characters.
    expect(
      errorsFor(JsonProbe, { payload: { a: 'x'.repeat(12) } }),
    ).toHaveLength(0);

    const [error] = errorsFor(JsonProbe, { payload: { a: 'x'.repeat(13) } });
    expect(error.property).toBe('payload');
    expect(error.constraints).toHaveProperty('maxJsonLength');
  });

  it('measures the escaped JSON, not the raw characters', () => {
    // Eight quotes are 8 characters of text but 16 once escaped: 24 in total.
    const [error] = errorsFor(JsonProbe, { payload: { a: '"'.repeat(8) } });
    expect(error.constraints).toHaveProperty('maxJsonLength');
  });

  it('rejects a value that cannot be serialized instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const dto = Object.assign(new JsonProbe(), { payload: circular });

    const [error] = validateSync(dto);
    expect(error.constraints).toHaveProperty('maxJsonLength');
  });

  it('leaves an omitted value to @IsOptional', () => {
    expect(errorsFor(JsonProbe, {})).toHaveLength(0);
  });
});
