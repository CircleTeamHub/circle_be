import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { LeaveCallDto } from './call.dto';

describe('LeaveCallDto', () => {
  // reason 的类型标注就是可选的,服务端也从不读它;缺了 @IsOptional 时,
  // 一个空 body 会被 @IsString 拒成 400,通话根本挂不断。
  it('accepts an empty body', () => {
    expect(validateSync(plainToInstance(LeaveCallDto, {}))).toHaveLength(0);
  });

  it('keeps accepting the mobile client shape', () => {
    expect(
      validateSync(plainToInstance(LeaveCallDto, { reason: 'NORMAL' })),
    ).toHaveLength(0);
  });

  it('rejects an oversized reason', () => {
    const errors = validateSync(
      plainToInstance(LeaveCallDto, { reason: 'a'.repeat(33) }),
    );
    expect(errors.some((error) => error.property === 'reason')).toBe(true);
  });
});
