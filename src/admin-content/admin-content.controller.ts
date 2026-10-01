import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminGuard } from 'src/guards/admin.guard';
import {
  AdminPermissionGuard,
  RequireAdminPermission,
} from 'src/admin-access/admin-permission.guard';
import { ListAdminPostsDto, ListAdminWordsDto } from './admin-content.dto';
import { AdminContentService } from './admin-content.service';

@Controller('admin/content')
@UseGuards(JwtGuard, AdminGuard, AdminPermissionGuard)
@RequireAdminPermission('MODERATION_MANAGE')
export class AdminContentController {
  constructor(private readonly service: AdminContentService) {}
  @Get('posts') list(@Query() query: ListAdminPostsDto) {
    return this.service.list(query);
  }
  @Get('posts/:id') detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }
  @Get('sensitive-words')
  @RequireAdminPermission('CONTENT_MANAGE')
  words(@Query() query: ListAdminWordsDto) {
    return this.service.words(query);
  }
}
