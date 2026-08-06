import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE = 'rawResponse';

/**
 * 跳过全局 ResponseInterceptor 的 {code,message,data} 信封，按控制器返回值
 * 原样出 JSON。只给「响应结构由外部协议钉死」的端点用（如 OpenIM webhook
 * 回调 —— OpenIM 只认顶层 actionCode/nextCode，包了信封等于全部放行）。
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);
