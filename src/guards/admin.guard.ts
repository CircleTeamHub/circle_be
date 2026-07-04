import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Role } from 'src/enum/roles.enum';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    return (
      request.user?.role === Role.Admin && request.user?.audience === 'ADMIN'
    );
  }
}
