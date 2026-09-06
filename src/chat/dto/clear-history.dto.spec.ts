import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ClearHistoryDto } from './clear-history.dto';

async function parse(input: Record<string, unknown>) {
  const dto = plainToInstance(ClearHistoryDto, input, {
    // 与 src/setup.ts 的全局 ValidationPipe 同款开关 —— 正是它带来下面这些坑。
    enableImplicitConversion: true,
  });
  return { dto, errors: await validate(dto) };
}

describe('ClearHistoryDto implicit conversion guards', () => {
  // enableImplicitConversion 会把 false→0。转换后再校验的话，`targetHeight: false`
  // 通过 @IsInt/@Min(0)，然后落进服务端的 `clearThrough <= 0` 分支：一条都不清，
  // 却返回 200 和 clearedBeforeHeight: 0，用户看到的是「已清空」。
  it('rejects a boolean target height instead of coercing it to zero', async () => {
    const { errors } = await parse({ forEveryone: true, targetHeight: false });
    expect(errors.length).toBeGreaterThan(0);
  });

  // 同一个开关把任意非空字符串转成 true，于是 `forEveryone: "false"` 会变成
  // 「清所有人的」—— 与用户的意思正好相反。
  it('rejects a string forEveryone instead of coercing it to true', async () => {
    const { errors } = await parse({ forEveryone: 'false' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('still accepts the real shapes', async () => {
    const { dto, errors } = await parse({
      forEveryone: true,
      targetHeight: 42,
    });
    expect(errors).toHaveLength(0);
    expect(dto.forEveryone).toBe(true);
    expect(dto.targetHeight).toBe(42);
  });

  it('treats both fields as optional', async () => {
    const { errors } = await parse({});
    expect(errors).toHaveLength(0);
  });
});
