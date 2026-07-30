import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  AddFancyNumberRecommendationsDto,
  AdminListFancyNumbersQueryDto,
  BatchCreateFancyNumbersDto,
  ReorderFancyNumberRecommendationsDto,
  SetFancyNumberAvailabilityDto,
  SetFancyNumberRecommendationDto,
} from './dto/fancy-number.dto';
import { FancyNumberService } from './fancy-number.service';

@ApiTags('Admin - Fancy Numbers')
@ApiBearerAuth()
@UseGuards(JwtGuard, AdminGuard)
@Controller('admin/mall/fancy-numbers')
export class FancyNumberAdminController {
  constructor(private readonly service: FancyNumberService) {}

  @Get()
  @ApiOperation({ summary: 'List all fancy-number inventory' })
  @ApiOkResponse()
  list(@Query() query: AdminListFancyNumbersQueryDto) {
    return this.service.adminList(query);
  }

  @Get('recommendations')
  @ApiOperation({ summary: 'List curated fancy-number recommendations' })
  @ApiOkResponse()
  listRecommendations() {
    return this.service.adminListRecommendations();
  }

  @Post('recommendations')
  @ApiOperation({ summary: 'Add curated fancy-number recommendations' })
  @ApiCreatedResponse()
  addRecommendations(
    @Body() dto: AddFancyNumberRecommendationsDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.adminAddRecommendations(req.user.userId, dto.values);
  }

  @Patch('recommendations/:id')
  @ApiOperation({ summary: 'Enable or disable a fancy-number recommendation' })
  @ApiOkResponse()
  setRecommendation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetFancyNumberRecommendationDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.adminSetRecommendation(
      req.user.userId,
      id,
      dto.recommended,
    );
  }

  @Put('recommendations/order')
  @ApiOperation({ summary: 'Reorder curated fancy-number recommendations' })
  @ApiOkResponse()
  reorderRecommendations(
    @Body() dto: ReorderFancyNumberRecommendationsDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.adminReorderRecommendations(
      req.user.userId,
      dto.expectedIds,
      dto.ids,
    );
  }

  @Post('batch')
  @ApiOperation({ summary: 'Add a batch of available fancy numbers' })
  @ApiOkResponse()
  batchCreate(
    @Body() dto: BatchCreateFancyNumbersDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.adminBatchCreate(req.user.userId, dto.values);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Enable or disable an available fancy number' })
  @ApiOkResponse()
  setAvailability(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetFancyNumberAvailabilityDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.adminSetAvailability(req.user.userId, id, dto.enabled);
  }
}
