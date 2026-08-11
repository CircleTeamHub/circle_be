import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminSupportAgentsDto, ReplaceSupportAgentsDto } from './support.dto';
import { SupportService } from './support.service';

@ApiTags('Admin · Support')
@ApiBearerAuth()
@UseGuards(JwtGuard, AdminGuard)
@Controller('admin/support')
export class SupportAdminController {
  constructor(private readonly support: SupportService) {}

  // 管理台读的是含停用行的全量,和 App 的 /support/config 不是同一份数据。
  @Get('agents')
  @ApiOperation({ summary: '客服账号配置(含停用行)' })
  @ApiOkResponse({ type: AdminSupportAgentsDto })
  async list(): Promise<AdminSupportAgentsDto> {
    return this.support.listForAdminWithRevision();
  }

  @Put('agents')
  @ApiOperation({ summary: '整表覆盖式写入客服账号配置' })
  @ApiOkResponse({ type: AdminSupportAgentsDto })
  async replace(
    @Req() req: RequestWithUser,
    @Body() body: ReplaceSupportAgentsDto,
  ): Promise<AdminSupportAgentsDto> {
    return this.support.replaceAgents(
      { userId: req.user.userId, accountId: req.user.accountId },
      body.agents,
      body.expectedRevision,
    );
  }
}
