import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import type { RequestWithUser } from 'src/auth/types';
import { AppAudienceGuard } from 'src/guards/app-audience.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import { GroupAdmissionService } from './group-admission.service';
class ApplyDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  reason?: string;
}
class ActionDto {
  @IsIn(['accept', 'decline', 'approve', 'reject'])
  action!: 'accept' | 'decline' | 'approve' | 'reject';
}
class PageDto {
  @IsOptional() @IsUUID('4') cursor?: string;
  @IsOptional() @IsUUID('4') groupId?: string;
}
@Controller('chat')
@UseGuards(JwtGuard, AppAudienceGuard, UserThrottlerGuard)
@ApiTags('Group admissions')
@ApiBearerAuth()
export class GroupAdmissionController {
  constructor(private readonly admissions: GroupAdmissionService) {}
  @Get('groups/:id/preview')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  preview(@Req() req: RequestWithUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admissions.preview(req.user.userId, id);
  }
  @Post('groups/:id/applications')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  apply(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ApplyDto,
  ) {
    return this.admissions.apply(req.user.userId, id, body.reason ?? '');
  }
  @Get('group-admissions')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  list(@Req() req: RequestWithUser, @Query() query: PageDto) {
    return this.admissions.list(req.user.userId, query.cursor, query.groupId);
  }
  @Get('group-admissions/unread')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  unread(@Req() req: RequestWithUser) {
    return this.admissions.unread(req.user.userId);
  }
  @Post('group-admissions/:id/seen')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  seen(@Req() req: RequestWithUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admissions.seen(req.user.userId, id);
  }
  @Get('group-admissions/:id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  detail(@Req() req: RequestWithUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admissions.detail(req.user.userId, id);
  }
  @Post('group-admissions/:id/action')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  act(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ActionDto,
  ) {
    return this.admissions.act(req.user.userId, id, body.action);
  }
}
