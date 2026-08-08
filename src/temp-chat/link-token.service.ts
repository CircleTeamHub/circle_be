import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TEMP_CHAT_GUEST_TOKEN_KIND } from 'src/chat/chat.constants';
import type { GuestChatTokenPayload } from 'src/chat/chat.types';

export interface LinkTokenPayload {
  tcId: string;
}

/**
 * 访客聊天凭证(join 后发放):kind 判别使其与分享链接 token 不可互换 ——
 * 拿分享链接直接连 socket 会因缺 kind/guestId 被网关拒绝。
 * 载荷类型与 kind 常量都定义在 chat 侧(依赖方向 TempChatModule → ChatModule),
 * 这里 re-export 给 temp-chat 内部沿用。
 */
export type { GuestChatTokenPayload };

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
      { kind: TEMP_CHAT_GUEST_TOKEN_KIND, ...payload },
      { expiresIn: expiresInSeconds },
    );
  }

  /** 校验访客凭证;分享链接 token(无 kind)在此被拒。 */
  verifyGuest(token: string): GuestChatTokenPayload {
    const payload = this.jwt.verify<GuestChatTokenPayload>(token);
    if (
      payload.kind !== TEMP_CHAT_GUEST_TOKEN_KIND ||
      typeof payload.guestId !== 'string' ||
      typeof payload.tcId !== 'string' ||
      typeof payload.conversationId !== 'string'
    ) {
      throw new Error('not a guest chat token');
    }
    return {
      kind: TEMP_CHAT_GUEST_TOKEN_KIND,
      guestId: payload.guestId,
      tcId: payload.tcId,
      conversationId: payload.conversationId,
    };
  }
}
