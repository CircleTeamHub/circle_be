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

export class LeaveCallDto {
  @IsString()
  reason?: string;
}
