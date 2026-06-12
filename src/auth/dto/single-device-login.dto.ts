import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SingleDeviceLoginDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  enabled: boolean;
}
