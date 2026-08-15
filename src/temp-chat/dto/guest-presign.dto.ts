import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 访客媒体上传预签名入参。刻意不复用 upload 的 PresignDto:
 * 匿名访客只开放聊天所需的图片/视频格式,并使用更低的单文件上限。
 */
export const GUEST_UPLOAD_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
];

/** 单张图上限。移动端拍照原图约 3–6 MiB,10 MiB 留足余量。 */
export const GUEST_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 访客视频单文件上限。仍受访客/房间累计字节配额约束。 */
export const GUEST_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export const GUEST_UPLOAD_MAX_BYTES = GUEST_VIDEO_MAX_BYTES;

export class GuestPresignDto {
  @ApiProperty({ example: 'photo.jpg', description: '原始文件名' })
  @IsString()
  @MaxLength(255)
  // 文件名只用于提取扩展名,无需把正常的 Unicode 名称拒之门外；但路径分隔符与
  // 控制字符仍须拒绝,避免它将来被误用于路径或响应头时引入穿越/注入风险。
  @Matches(/^[^/\\\u0000-\u001f\u007f]+$/u, {
    message: 'filename contains invalid characters',
  })
  filename: string;

  @ApiProperty({
    example: 'image/jpeg',
    enum: GUEST_UPLOAD_CONTENT_TYPES,
    description: 'MIME type(访客聊天图片或视频)',
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
