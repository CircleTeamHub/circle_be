import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'My Nickname', description: 'Display name' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  nickname?: string;

  @ApiPropertyOptional({
    example: 'https://example.com/avatar.png',
    description: 'Avatar URL',
  })
  @IsOptional()
  @IsUrl()
  avatarUrl?: string;
}
