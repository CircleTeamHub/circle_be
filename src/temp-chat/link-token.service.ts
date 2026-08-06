import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface LinkTokenPayload {
  tcId: string;
}

/**
 * 访客聊天凭证(join 后发放):kind 判别使其与分享链接 token 不可互换 ——
 * 拿分享链接直接连 socket 会因缺 kind/guestId 被网关拒绝。
 * 与 chat 网关的访客验签是同一份契约(同秘钥 TEMP_CHAT_LINK_SECRET)。
 */
export interface GuestChatTokenPayload {
  kind: 'temp-chat-guest';
  guestId: string;
  tcId: string;
  conversationId: string;
}

@Injectable()
export class LinkTokenService {
  constructor(private readonly jwt: JwtService) {}

  /** expiresInSeconds: 与房间 expiresAt 对齐的剩余秒数。 */
  sign(tcId: string, expiresInSeconds: number): string {
    return this.jwt.sign({ tcId }, { expiresIn: expiresInSeconds });
  }

  /** 校验签名 + 过期；非法/过期抛错（由调用方转 404/410）。 */
  verify(token: string): LinkTokenPayload {
    const payload = this.jwt.verify<LinkTokenPayload>(token);
    return { tcId: payload.tcId };
  }

  /** 访客聊天凭证:socket 握手与访客历史接口共用。 */
  signGuest(
    payload: Omit<GuestChatTokenPayload, 'kind'>,
    expiresInSeconds: number,
  ): string {
    return this.jwt.sign(
      { kind: 'temp-chat-guest', ...payload },
      { expiresIn: expiresInSeconds },
    );
  }

  /** 校验访客凭证;分享链接 token(无 kind)在此被拒。 */
  verifyGuest(token: string): GuestChatTokenPayload {
    const payload = this.jwt.verify<GuestChatTokenPayload>(token);
    if (
      payload.kind !== 'temp-chat-guest' ||
      typeof payload.guestId !== 'string' ||
      typeof payload.tcId !== 'string' ||
      typeof payload.conversationId !== 'string'
    ) {
      throw new Error('not a guest chat token');
    }
    return {
      kind: 'temp-chat-guest',
      guestId: payload.guestId,
      tcId: payload.tcId,
      conversationId: payload.conversationId,
    };
  }
}
