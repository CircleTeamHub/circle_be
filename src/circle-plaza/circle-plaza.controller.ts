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
  @ApiOperation({
    summary: 'Plaza feed (paginated, filterable by circle/city)',
  })
  feed(
    @Query() query: PlazaFeedQueryDto,
    @Req() req: RequestWithUser,
  ): Promise<{
    items: PlazaPostDto[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    return this.plazaService.getFeed(req.user.userId, query);
  }

  @Post('posts')
  @ApiOperation({ summary: 'Create a plaza post' })
  @ApiOkResponse({ type: PlazaPostDto })
  create(
    @Body() dto: CreatePlazaPostDto,
    @Req() req: RequestWithUser,
  ): Promise<PlazaPostDto> {
    return this.plazaService.createPost(req.user.userId, dto);
  }

  @Get('posts/:id')
  @ApiOperation({ summary: 'Single post detail' })
  @ApiOkResponse({ type: PlazaPostDto })
  getPost(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<PlazaPostDto> {
    return this.plazaService.getPost(req.user.userId, id);
  }

  @Delete('posts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete own post (soft delete)' })
  @ApiNoContentResponse()
  deletePost(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.plazaService.deletePost(req.user.userId, id);
  }

  @Post('posts/:id/signup')
  @ApiOperation({ summary: 'Sign up for a post' })
  signup(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<{ signed: boolean; signupCount: number }> {
    return this.plazaService.signupForPost(req.user.userId, id);
  }

  @Delete('posts/:id/signup')
  @ApiOperation({ summary: 'Cancel signup for a post' })
  cancelSignup(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<{ signed: boolean; signupCount: number }> {
    return this.plazaService.cancelSignup(req.user.userId, id);
  }

  @Get('posts/:id/signups')
  @ApiOperation({ summary: 'List users who signed up for a post' })
  signups(@Param('id', ParseUUIDPipe) id: string) {
    return this.plazaService.getPostSignups(id);
  }
}
