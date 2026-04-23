import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { CollectionService } from './collection.service';
import {
  CreateCollectionDto,
  ListCollectionsQueryDto,
  UserCollectionDto,
} from './dto/collection.dto';

@ApiTags('Collections')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('collections')
export class CollectionController {
  constructor(private readonly collectionService: CollectionService) {}

  @Get()
  @ApiOperation({ summary: 'List my collections' })
  @ApiOkResponse({ type: [UserCollectionDto] })
  list(
    @Query() query: ListCollectionsQueryDto,
    @Req() req: any,
  ): Promise<UserCollectionDto[]> {
    return this.collectionService.list(req.user.userId, query.type);
  }

  @Post()
  @ApiOperation({ summary: 'Create a collection item' })
  @ApiOkResponse({ type: UserCollectionDto })
  create(
    @Body() dto: CreateCollectionDto,
    @Req() req: any,
  ): Promise<UserCollectionDto> {
    return this.collectionService.create(req.user.userId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete one of my collection items' })
  @ApiNoContentResponse()
  remove(@Param('id') id: string, @Req() req: any): Promise<void> {
    return this.collectionService.remove(req.user.userId, id);
  }
}
