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
  ApiAcceptedResponse,
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
  SetCircleCoverDto,
  SetCircleAvatarDto,
} from './dto/circle.dto';
import { InvitationDto } from 'src/circle-invitation/dto/circle-invitation.dto';

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
  @ApiOperation({ summary: 'List circles available to apply for' })
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
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Submit a circle membership application' })
  @ApiAcceptedResponse({ type: InvitationDto })
  join(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<InvitationDto> {
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

  @Post(':id/cover')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Set the circle cover image' })
  @ApiNoContentResponse()
  setCover(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetCircleCoverDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.circleService.setCircleCover(req.user.userId, id, dto.cover);
  }

  @Post(':id/avatar')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Set the circle avatar image' })
  @ApiNoContentResponse()
  setAvatar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetCircleAvatarDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.circleService.setCircleAvatar(
      req.user.userId,
      id,
      dto.avatarUrl,
    );
  }
}
