import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

// 图片/视频:所有目录通用。
const VISUAL_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime', // .mov
  'video/x-m4v',
];

/**
 * 语音与文件:**只对 chat 目录开放**(UploadService.presign 按目录二次收口)。
 *
 * 自研聊天协议接受 voice / file 两种消息类型,并要求它们携带 chat/{userId}/ 的
 * object key —— 而唯一能签出这种 key 的 POST /upload/presign 此前只放行
 * image/video,于是一段 audio/mp4 录音或一个 pdf 在拿到上传授权之前就被 DTO 拒了:
 * 这两个"已支持"的消息类型实际根本发不出去。
 *
 * 不能直接并进通用清单:那等于头像、封面、圈子帖目录也能上传 pdf/可执行体。
 */
const CHAT_ONLY_CONTENT_TYPES = [
  // 语音:iOS 录 m4a(audio/mp4)、Android 多为 aac/ogg,webm 来自 Web 端。
  'audio/mp4',
  'audio/m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/ogg',
  'audio/webm',
  'audio/wav',
  // 文件:常见办公与压缩格式,刻意不含任何可执行/脚本类型。
  'application/pdf',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
];

export const CHAT_ONLY_UPLOAD_TYPES: readonly string[] =
  CHAT_ONLY_CONTENT_TYPES;

const ALLOWED_CONTENT_TYPES = [
  ...VISUAL_CONTENT_TYPES,
  ...CHAT_ONLY_CONTENT_TYPES,
];

const ALLOWED_FOLDERS = [
  'avatars',
  'covers',
  'posts',
  'notes',
  'chat',
  'friends',
] as const;
export type UploadFolder = (typeof ALLOWED_FOLDERS)[number];

export class PresignDto {
  @ApiProperty({ example: 'avatar.jpg', description: '原始文件名' })
  @IsString()
  @Matches(/^[\w\-. ]+$/, { message: 'filename contains invalid characters' })
  filename: string;

  @ApiProperty({
    example: 'image/jpeg',
    enum: ALLOWED_CONTENT_TYPES,
    description: 'MIME type',
  })
  @IsIn(ALLOWED_CONTENT_TYPES)
  contentType: string;

  @ApiProperty({
    example: 1048576,
    minimum: 1,
    maximum: 104857600,
    description: 'Exact upload size in bytes; included in the signed request',
  })
  @IsInt()
  @Min(1)
  @Max(100 * 1024 * 1024)
  sizeBytes: number;

  @ApiPropertyOptional({
    example: 'avatars',
    enum: ALLOWED_FOLDERS,
    description: '存储目录，默认 avatars',
  })
  @IsOptional()
  @IsIn(ALLOWED_FOLDERS)
  folder?: UploadFolder;
}
