import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ChatService } from 'src/chat/chat.service';
import { TempChatErrorCode } from 'src/common/app-error-codes';
import {
  LinkTokenService,
  type GuestChatTokenPayload,
} from './link-token.service';

export interface RequestWithTempChatGuest extends Request {
  tempChatGuest: GuestChatTokenPayload;
}

/**
 * 访客聊天凭证守卫(Bearer <chatToken>):验签失败/形态不符统一 404,
 * 与 by-token 路由同口径 —— 不向探测者泄露端点存在性。
 *
 * 光验签不够:token 的有效期是签发时按房间剩余时长定的,一旦房间提前结束、
 * 过期,或者访客被清座,签名依然有效 —— 而上传预签名这类端点只看签名,于是
 * 已经出局的访客还能继续烧配额、拿新的对象存储授权。房间在役 + 座位仍在
 * 这两道与网关握手同源,放在守卫里做,所有访客端点一次覆盖。
 */
@Injectable()
export class TempChatGuestGuard implements CanActivate {
  constructor(
    private readonly linkToken: LinkTokenService,
    private readonly chatService: ChatService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithTempChatGuest>();
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : '';
    let payload: GuestChatTokenPayload;
    try {
      payload = this.linkToken.verifyGuest(token);
    } catch {
      throw this.reject();
    }

    const [roomActive, seated] = await Promise.all([
      this.chatService.getActiveTempChat(payload.tcId),
      this.chatService.hasSeat(payload.conversationId, payload.guestId),
    ]);
    // 房间没了或座位没了都按「链接无效」回,与验签失败同口径:区分开等于把
    // 房间状态做成匿名可探测的接口。
    if (!roomActive || !seated) throw this.reject();

    request.tempChatGuest = payload;
    return true;
  }

  private reject(): NotFoundException {
    return new NotFoundException({
      message: '链接无效',
      errorCode: TempChatErrorCode.LinkInvalid,
    });
  }
}
