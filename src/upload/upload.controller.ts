import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import { PresignDto } from './dto/presign.dto';
import { UploadService } from './upload.service';

@ApiTags('upload')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post('presign')
  @ApiOperation({
    summary: '获取预签名上传 URL',
    description:
      '返回 uploadUrl（PUT 文件用，5 分钟有效）和 fileUrl（上传后的永久访问地址）',
  })
  async presign(@Body() dto: PresignDto) {
    return this.uploadService.presign(
      dto.filename,
      dto.contentType,
      dto.folder ?? 'avatars',
    );
  }
}
