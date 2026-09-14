import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
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
  /**
   * 客户端的挂断原因标签(App 发 'NORMAL'),服务端从不读它。
   * 类型标注就是可选的,缺了 @IsOptional 时空 body 会被拒成 400,通话挂不断。
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  reason?: string;
}
