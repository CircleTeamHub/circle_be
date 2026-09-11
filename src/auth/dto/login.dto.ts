import {
  IsIn,
  IsNotEmpty,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * identifier 到底「填了没有」—— 判据必须与 auth.service 的
 * `dto.identifier?.trim() || dto.email?.trim()` 完全一致:那里 null / '' / 全空白
 * 都会落到 email 兜底上,所以这三种在这里也必须算作「没填」。
 *
 * 反过来,任何**非字符串**的值(数字、对象)都算「填了」:它进不了 `.trim()`,
 * 放过去就是服务层一个 TypeError,必须被 @IsString 拦成 400。
 */
function identifierProvided(dto: LoginDto): boolean {
  const value: unknown = dto.identifier;
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/** email 兜底可用(是非空字符串)时,才允许跳过 identifier 的校验。 */
function emailFallbackAvailable(dto: LoginDto): boolean {
  const value: unknown = dto.email;
  return typeof value === 'string' && value.trim().length > 0;
}

export class LoginDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'Email address or user ID',
    required: false,
  })
  // 填了就校验;没填则只有在连 email 兜底都没有时才校验(两个都缺要报 400)。
  @ValidateIf(
    (dto: LoginDto) => identifierProvided(dto) || !emailFallbackAvailable(dto),
  )
  @IsString()
  @IsNotEmpty()
  @Length(1, 254)
  identifier?: string;

  /** Backward-compatible alias for clients that still send the email field. */
  @ApiPropertyOptional({
    example: 'user@example.com',
    deprecated: true,
    description: 'Deprecated; use identifier instead',
  })
  // identifier 没填时才看 email —— 判据与上面同一个,否则 `identifier: '   '`
  // 会让两边都跳过,一条既没有 identifier 也没有合法 email 的请求照样通过校验。
  @ValidateIf((dto: LoginDto) => !identifierProvided(dto))
  @IsEmail()
  email?: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 64)
  password: string;

  /** OpenIM platform ID — 1=iOS, 2=Android, 5=Web. */
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsIn([1, 2, 5])
  platform?: 1 | 2 | 5;
}
