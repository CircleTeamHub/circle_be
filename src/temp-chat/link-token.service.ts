import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface LinkTokenPayload {
  tcId: string;
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
}
