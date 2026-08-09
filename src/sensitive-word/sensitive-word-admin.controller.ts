import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  MaxLength,
} from 'class-validator';
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminGuard } from 'src/guards/admin.guard';
import type { RequestWithUser } from 'src/auth/types';
import { AdminAuditService } from 'src/moderation/admin-audit.service';
import { SensitiveWordService } from './sensitive-word.service';

class MutateWordsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  words!: string[];
}

function auditContext(req: RequestWithUser) {
  return {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

/**
 * 聊天敏感词词表管理（与 moderation admin 同構，动作进 AdminAuditLog）。
 * 词条批量导入公开词库时走 add 分批（单批 ≤1000）。审计 best-effort：
 * 词表 CRUD 无状态机语义，审计行缺失不影响业务正确性。
 */
@ApiTags('Admin · Sensitive Words')
@ApiBearerAuth()
@UseGuards(JwtGuard, AdminGuard)
@Controller('admin/sensitive-words')
export class SensitiveWordAdminController {
  constructor(
    private readonly service: SensitiveWordService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all sensitive words' })
  list() {
    return this.service.listWords();
  }

  @Post('add')
  @ApiOperation({ summary: 'Add sensitive words (bulk, normalized, deduped)' })
  async add(@Body() dto: MutateWordsDto, @Req() req: RequestWithUser) {
    const result = await this.service.addWords(dto.words, req.user.userId);
    await this.audit.record({
      actorID: req.user.userId,
      action: 'sensitive_word.add',
      entityType: 'SensitiveWord',
      after: { words: dto.words, added: result.added },
      ...auditContext(req),
    });
    return result;
  }

  @Post('remove')
  @ApiOperation({ summary: 'Remove sensitive words (bulk)' })
  async remove(@Body() dto: MutateWordsDto, @Req() req: RequestWithUser) {
    const result = await this.service.removeWords(dto.words, req.user.userId);
    await this.audit.record({
      actorID: req.user.userId,
      action: 'sensitive_word.remove',
      entityType: 'SensitiveWord',
      after: { words: dto.words, removed: result.removed },
      ...auditContext(req),
    });
    return result;
  }
}
