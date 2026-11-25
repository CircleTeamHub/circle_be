import { ConflictException } from '@nestjs/common';
import { AuthErrorCode } from 'src/common/app-error-codes';

/** Leave the current browser cookie untouched when a different tab owns it. */
export class WebSessionChangedException extends ConflictException {
  constructor() {
    super({
      errorCode: AuthErrorCode.WebSessionChanged,
      message: '网页登录状态已变更，请刷新页面后继续',
    });
  }
}
