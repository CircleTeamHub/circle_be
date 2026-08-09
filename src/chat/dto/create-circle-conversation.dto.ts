import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateCircleConversationDto {
  @ApiProperty({ description: '圈子 id' })
  @IsUUID()
  circleId!: string;
}
