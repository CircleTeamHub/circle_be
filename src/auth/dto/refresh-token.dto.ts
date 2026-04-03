import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({ example: 'c8c1f46b2b9c...' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
