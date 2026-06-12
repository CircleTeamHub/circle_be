import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

const SECURITY_CODE_PATTERN = /^\d{4,6}$/;

export class SetLoginSecurityCodeDto {
  @ApiProperty({ example: '1234', description: '4-6 digit security code' })
  @IsString()
  @IsNotEmpty()
  @Matches(SECURITY_CODE_PATTERN, {
    message: 'securityCode must be 4-6 digits',
  })
  securityCode: string;

  @ApiPropertyOptional({
    example: '654321',
    description: 'Current security code when changing an existing code',
  })
  @IsOptional()
  @IsString()
  @Matches(SECURITY_CODE_PATTERN, {
    message: 'oldSecurityCode must be 4-6 digits',
  })
  oldSecurityCode?: string;
}

export class LoginSecurityCodeDto {
  @ApiProperty({ example: '1234', description: '4-6 digit security code' })
  @IsString()
  @IsNotEmpty()
  @Matches(SECURITY_CODE_PATTERN, {
    message: 'securityCode must be 4-6 digits',
  })
  securityCode: string;
}
