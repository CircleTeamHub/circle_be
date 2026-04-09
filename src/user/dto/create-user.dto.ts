import { IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({ example: 'jimmyddddd' })
  @IsString()
  @IsNotEmpty()
  @Length(4, 32)
  accountId: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 64)
  password: string;

  @ApiPropertyOptional({ example: 'Jimmy' })
  @IsString()
  @IsOptional()
  @Length(1, 30)
  nickname?: string;
}
