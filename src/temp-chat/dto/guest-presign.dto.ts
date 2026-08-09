import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Matches, Max, Min } from 'class-validator';

/**
 * 访客发图的上传预签名入参。刻意不复用 upload 的 PresignDto:
 * 那份放行 video/* 且上限 100 MiB,而这个端点只用于访客聊天发图 ——
 * 拿着 bearer 凭证的匿名访客不该有申请 100 MiB 授权的能力。
 */
export const GUEST_UPLOAD_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
];

/** 单张图上限。移动端拍照原图约 3–6 MiB,10 MiB 留足余量。 */
export const GUEST_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export class GuestPresignDto {
  @ApiProperty({ example: 'photo.jpg', description: '原始文件名' })
  @IsString()
  @Matches(/^[\w\-. ]+$/, { message: 'filename contains invalid characters' })
  filename: string;

  @ApiProperty({
    example: 'image/jpeg',
    enum: GUEST_UPLOAD_CONTENT_TYPES,
    description: 'MIME type(访客只允许图片)',
  })
  @IsIn(GUEST_UPLOAD_CONTENT_TYPES)
  contentType: string;

  @ApiProperty({
    example: 1048576,
    minimum: 1,
    maximum: GUEST_UPLOAD_MAX_BYTES,
    description: '精确字节数;会进签名请求,超限直接拒发授权',
  })
  @IsInt()
  @Min(1)
  @Max(GUEST_UPLOAD_MAX_BYTES)
  sizeBytes: number;
}
