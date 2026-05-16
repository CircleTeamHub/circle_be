import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

const ALLOWED_CONTENT_TYPES = [
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

const ALLOWED_FOLDERS = [
  'avatars',
  'covers',
  'posts',
  'notes',
  'chat',
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

  @ApiPropertyOptional({
    example: 'avatars',
    enum: ALLOWED_FOLDERS,
    description: '存储目录，默认 avatars',
  })
  @IsOptional()
  @IsIn(ALLOWED_FOLDERS)
  folder?: UploadFolder;
}
