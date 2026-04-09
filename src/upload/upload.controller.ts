import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import { PresignDto } from './dto/presign.dto';
import { UploadService } from './upload.service';

@ApiTags('upload')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('upload')
export class UploadController {
  /**
   * Per-user presign rate limit: max 20 requests per minute.
   * Keyed by userId so distributed users don't share quota,
   * and a stolen token can't spam the bucket at full global speed.
   */
  private readonly userPresignCounts = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private static readonly PRESIGN_LIMIT = 20;
  private static readonly PRESIGN_WINDOW_MS = 60_000;

  constructor(private readonly uploadService: UploadService) {}

  @Post('presign')
  @ApiOperation({
    summary: '获取预签名上传 URL',
    description:
      '返回 uploadUrl（PUT 文件用，5 分钟有效）和 fileUrl（上传后的永久访问地址）',
  })
  async presign(@Body() dto: PresignDto, @Req() req: any) {
    this.checkUserPresignLimit(req.user.userId);
    return this.uploadService.presign(
      dto.filename,
      dto.contentType,
      dto.folder ?? 'avatars',
    );
  }

  private checkUserPresignLimit(userId: string): void {
    const now = Date.now();
    const entry = this.userPresignCounts.get(userId);

    if (!entry || now >= entry.resetAt) {
      this.userPresignCounts.set(userId, {
        count: 1,
        resetAt: now + UploadController.PRESIGN_WINDOW_MS,
      });
      return;
    }

    if (entry.count >= UploadController.PRESIGN_LIMIT) {
      throw new HttpException(
        'Too many upload requests. Please wait before requesting more upload URLs.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    entry.count += 1;
  }
}
