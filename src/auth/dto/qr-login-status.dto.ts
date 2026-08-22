import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 轮询凭证走 body 而不是 query。pollKey 是换取会话的那把钥匙，进了 URL 就会
 * 沿着「开发日志 → 反代访问日志 → 异常上报里的 request.url」一路留痕，
 * 而 AllExceptionFilter 的脱敏名单并不认识 `key` 这个参数名。
 */
export class QrLoginStatusDto {
  // randomBytes(24).toString('base64url') = 32 chars
  @ApiProperty({ example: 'kO2m1Qq7t0Zx...' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  pollKey: string;
}
