import { IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'testuser' })
  @IsString()
  @IsNotEmpty()
  @Length(4, 20)
  username: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 64)
  password: string;

  @ApiPropertyOptional({ example: 'Test User' })
  @IsOptional()
  @IsString()
  @Length(1, 30)
  nickname?: string;
}
