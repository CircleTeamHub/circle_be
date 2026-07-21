import { IsArray, IsEnum, IsString, ArrayMaxSize } from 'class-validator';
import { CallType } from 'src/generated/prisma';

export class CreateGroupCallDto {
  @IsString()
  conversationID!: string;

  @IsEnum(CallType)
  callType!: CallType;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  inviteeIDs!: string[];
}

export class CreateDirectCallDto {
  /** 被叫方 User.id。必须是发起者的已接受好友且双向未拉黑。 */
  @IsString()
  calleeID!: string;

  @IsEnum(CallType)
  callType!: CallType;
}

export class LeaveCallDto {
  @IsString()
  reason?: string;
}
