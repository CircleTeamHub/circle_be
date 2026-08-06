import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
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
 */
@Injectable()
export class TempChatGuestGuard implements CanActivate {
  constructor(private readonly linkToken: LinkTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithTempChatGuest>();
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : '';
    try {
      request.tempChatGuest = this.linkToken.verifyGuest(token);
      return true;
    } catch {
      throw new NotFoundException({
        message: '链接无效',
        errorCode: TempChatErrorCode.LinkInvalid,
      });
    }
  }
}
