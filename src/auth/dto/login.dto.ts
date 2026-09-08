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

export class LoginDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'Email address or user ID',
    required: false,
  })
  @ValidateIf(
    (dto: LoginDto) => dto.identifier !== undefined || dto.email === undefined,
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
  @ValidateIf((dto: LoginDto) => !dto.identifier)
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
