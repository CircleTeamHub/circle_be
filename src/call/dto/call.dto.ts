import { ApiHideProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
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

export class LeaveCallDto {
  /**
   * @deprecated accepted and ignored.
   *
   * 已装机的 App 挂断时固定发 `{ reason: 'NORMAL' }`,服务端从不读它:结束原因
   * (CallSession.endReason)由服务端按状态机推导(NORMAL / ALL_LEFT / NO_ANSWER …),
   * 不接受客户端自报 —— 那等于允许伪造通话留痕。
   * 移除条件:最低支持的 App 版本已不再发送该字段(circle-im 自
   * fix/audit-backend-contract-drift 起不再发送)。在那之前必须继续接受:全局
   * ValidationPipe 开着 forbidNonWhitelisted,删掉它旧客户端的挂断会被拒成 400。
   */
  @ApiHideProperty()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  reason?: string;
}
