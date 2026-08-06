import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateDirectConversationDto {
  @ApiProperty({ description: '对端用户 id' })
  @IsUUID()
  peerUserId!: string;
}
