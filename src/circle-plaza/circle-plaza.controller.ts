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
import { CirclePlazaService } from './circle-plaza.service';
import {
  CreatePlazaPostDto,
  PlazaFeedQueryDto,
  PlazaPostDto,
} from './dto/circle-plaza.dto';

@ApiTags('Circle Plaza')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('circle-plaza')
export class CirclePlazaController {
  constructor(private readonly plazaService: CirclePlazaService) {}

  @Get('feed')
  @ApiOperation({ summary: 'Plaza feed (paginated, filterable by circle/city)' })
  feed(
    @Query() query: PlazaFeedQueryDto,
    @Req() req: any,
  ): Promise<{ items: PlazaPostDto[]; total: number; page: number; limit: number; hasMore: boolean }> {
    return this.plazaService.getFeed(req.user.userId, query);
  }

  @Post('posts')
  @ApiOperation({ summary: 'Create a plaza post' })
  @ApiOkResponse({ type: PlazaPostDto })
  create(
    @Body() dto: CreatePlazaPostDto,
    @Req() req: any,
  ): Promise<PlazaPostDto> {
    return this.plazaService.createPost(req.user.userId, dto);
  }

  @Get('posts/:id')
  @ApiOperation({ summary: 'Single post detail' })
  @ApiOkResponse({ type: PlazaPostDto })
  getPost(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
  ): Promise<PlazaPostDto> {
    return this.plazaService.getPost(req.user.userId, id);
  }

  @Delete('posts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete own post (soft delete)' })
  @ApiNoContentResponse()
  deletePost(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
  ): Promise<void> {
    return this.plazaService.deletePost(req.user.userId, id);
  }
}
