import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import type { RequestWithUser } from 'src/auth/types';
import { uploadMetrics } from 'src/metrics/upload-metrics';
import { UploadLimitService } from './upload-limit.service';
import { PresignDto, UPLOAD_FOLDERS } from './dto/presign.dto';
import { PUBLIC_READ_UPLOAD_FOLDERS, UploadService } from './upload.service';

/** App 可选但不在匿名可读白名单里的目录(notes、chat、stickers):对象只能凭 key 签名读取。 */
const PRIVATE_UPLOAD_FOLDERS = UPLOAD_FOLDERS.filter(
  (folder) =>
    !(PUBLIC_READ_UPLOAD_FOLDERS as readonly string[]).includes(folder),
);

@ApiTags('upload')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('upload')
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly uploadLimit: UploadLimitService,
  ) {}

  @Post('presign')
  @ApiOperation({
    summary: '获取预签名上传 URL',
    description:
      `返回 uploadUrl（PUT 上传用；图片 5 分钟、视频 30 分钟有效）、key 与 fileUrl。` +
      `fileUrl 只对公开目录（${PUBLIC_READ_UPLOAD_FOLDERS.join('、')}）有值，可直接读取；` +
      `私有目录（${PRIVATE_UPLOAD_FOLDERS.join('、')}）的对象直连会被拒绝，fileUrl 固定为 null，` +
      `一律保存 key，由对应读路径（聊天消息 / 笔记详情 / 表情列表）按 key 签发短时 GET URL 读取。`,
  })
  async presign(@Body() dto: PresignDto, @Req() req: RequestWithUser) {
    await this.uploadLimit.check(req.user.userId, dto.sizeBytes);
    // Pass userId for user-scoped folders so keys are namespaced per user,
    // enabling server-side ownership verification at upload time.
    const startedAt = process.hrtime.bigint();
    try {
      const result = await this.uploadService.presign(
        dto.filename,
        dto.contentType,
        dto.sizeBytes,
        dto.folder ?? 'avatars',
        req.user.userId,
      );
      uploadMetrics.observePresign(
        'success',
        Number(process.hrtime.bigint() - startedAt) / 1e9,
        dto.sizeBytes,
      );
      return result;
    } catch (error) {
      uploadMetrics.observePresign(
        'failure',
        Number(process.hrtime.bigint() - startedAt) / 1e9,
        dto.sizeBytes,
      );
      throw error;
    }
  }
}
