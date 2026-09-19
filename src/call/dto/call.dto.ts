import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { CallType } from 'src/generated/prisma';

/**
 * 群呼会话标识的字符集。App 传自研聊天的会话 id(uuid),但服务端还认 Circle.id 与
 * sg_ 前缀 / 旧 OpenIM 形态的 Circle.groupID(见 CallService.groupIDCandidates),
 * 不是 uuid-only —— 这里只收长度与安全字符集,真实性由 assertGroupMembers 按库判定。
 */
const CALL_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class CreateGroupCallDto {
  @IsString()
  @MaxLength(64)
  @Matches(CALL_CONVERSATION_ID_PATTERN, {
    message: 'conversationID contains invalid characters',
  })
  conversationID!: string;

  @IsEnum(CallType)
  callType!: CallType;

  /**
   * 被邀请人的 User.id。通话服务不做别名归一,loadActiveUsers 只认 ACTIVE 用户,
   * 能成功的只有 uuid。
   */
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  inviteeIDs!: string[];
}

export class CreateDirectCallDto {
  /** 被叫方 User.id(uuid)。必须是发起者的已接受好友且双向未拉黑。 */
  @IsUUID()
  calleeID!: string;

  @IsEnum(CallType)
  callType!: CallType;
}
