import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * 只放行 APP audience 的会话。
 *
 * 管理台走 /auth/admin/login 拿的是 ADMIN audience 的短 TTL token,它的能力面
 * 只该覆盖管理接口。聊天是普通用户能力:管理台没有任何消息 UI,却因为
 * ADMIN token 同样能过 JwtGuard 而事实上具备了收发消息的能力。
 *
 * 拆 OpenIM 之前这道闸在 /auth/im-token 里(显式拒 ADMIN audience);自研栈
 * 直接复用 app JWT 连 socket,那道闸就随着端点一起没了 —— 这是迁移带回来的
 * 能力扩张,不是新需求。WS 侧在 ChatGateway.authenticate 里同源判定。
 *
 * 放在 JwtGuard 之后使用:依赖 request.user.audience(AuthStrategy 填充)。
 */
@Injectable()
export class AppAudienceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (request.user?.audience !== 'APP') {
      throw new ForbiddenException('This endpoint requires an app session');
    }
    return true;
  }
}
