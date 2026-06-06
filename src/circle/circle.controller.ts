import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import type { RequestWithUser } from 'src/auth/types';
import { CircleService } from './circle.service';
import {
  CircleDetailDto,
  CircleDto,
  CreateCircleDto,
  ListCirclesQueryDto,
  MyCirclesQueryDto,
  SelectCircleIconDto,
  UploadCircleIconDto,
} from './dto/circle.dto';

@ApiTags('Circle')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('circle')
export class CircleController {
  constructor(private readonly circleService: CircleService) {}

  @Post()
  @ApiOperation({ summary: 'Create a circle' })
  @ApiOkResponse({ type: CircleDetailDto })
  create(
    @Body() dto: CreateCircleDto,
    @Req() req: RequestWithUser,
  ): Promise<CircleDetailDto> {
    return this.circleService.createCircle(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List public circles' })
  list(@Query() query: ListCirclesQueryDto): Promise<{
    items: CircleDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.circleService.listCircles(query);
  }

  @Get('my')
  @ApiOperation({ summary: 'My circles (joined / created / applied)' })
  @ApiOkResponse({ type: [CircleDto] })
  myCircles(
    @Query() query: MyCirclesQueryDto,
    @Req() req: RequestWithUser,
  ): Promise<CircleDto[]> {
    return this.circleService.myCircles(req.user.userId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Circle detail' })
  @ApiOkResponse({ type: CircleDetailDto })
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<CircleDetailDto> {
    return this.circleService.getCircleDetail(req.user.userId, id);
  }

  @Post(':id/join')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Join a circle' })
  @ApiNoContentResponse()
  join(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.circleService.joinCircle(req.user.userId, id);
  }

  @Delete(':id/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Leave a circle' })
  @ApiNoContentResponse()
  leave(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.circleService.leaveCircle(req.user.userId, id);
  }

  @Post(':id/icon/upload')
  @ApiOperation({ summary: 'Upload a circle icon asset' })
  uploadIcon(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadCircleIconDto,
    @Req() req: any,
  ) {
    return this.circleService.uploadCircleIcon(req.user.userId, id, dto);
  }

  @Post(':id/icon/select')
  @ApiOperation({ summary: 'Select the current circle icon' })
  selectIcon(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SelectCircleIconDto,
    @Req() req: any,
  ) {
    return this.circleService.selectCircleIcon(req.user.userId, id, dto);
  }

  @Get('activities/list')
  @ApiOperation({ summary: 'My circle activities (notifications)' })
  activities(@Req() req: RequestWithUser) {
    return this.circleService.getActivities(req.user.userId);
  }

  @Get('activities/unread-count')
  @ApiOperation({ summary: 'Unread circle activity count' })
  unreadCount(@Req() req: RequestWithUser) {
    return this.circleService.getUnreadActivityCount(req.user.userId);
  }

  @Post('activities/read-all')
  @ApiOperation({ summary: 'Mark all my circle activities as read' })
  markAllRead(@Req() req: RequestWithUser): Promise<{ count: number }> {
    return this.circleService.markAllActivitiesRead(req.user.userId);
  }

  @Post('activities/:activityId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark circle activity as read' })
  @ApiNoContentResponse()
  markRead(
    @Param('activityId', ParseUUIDPipe) activityId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.circleService.markActivityRead(req.user.userId, activityId);
  }
}
