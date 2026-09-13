import { applyDecorators } from '@nestjs/common';
import { IsDefined, ValidateIf } from 'class-validator';

/**
 * `@IsOptional()` for properties backed by a non-nullable column: an omitted
 * (undefined) property skips validation, an explicit `null` is rejected with
 * `isDefined`, and any other value runs the remaining validators as usual.
 *
 * `@IsOptional()` skips validation for null as well as undefined, and the
 * global ValidationPipe's implicit conversion keeps null as-is — so
 * `{ "nickname": null }` passed the pipe and only failed at Prisma as a
 * PrismaClientValidationError (500 + Sentry). Keep `@IsOptional()` on nullable
 * columns where null means "clear".
 */
export function IsOptionalNotNull(): PropertyDecorator {
  return applyDecorators(
    ValidateIf((_object: object, value: unknown) => value !== undefined),
    IsDefined(),
  );
}
