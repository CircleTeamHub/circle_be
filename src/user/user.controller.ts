import {
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  ForbiddenException,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import { UserErrorCode } from 'src/common/app-error-codes';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserService } from './user.service';
import { GetUserDto } from './dto/get-user.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { VipLevelsDto } from './dto/vip-levels.dto';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { Serialize } from 'src/decorators/serialize.decorator';
import {
  ProfileUserDto,
  PublicUserDto,
  SelfUserDto,
} from './dto/public-user.dto';
import { Role } from 'src/enum/roles.enum';
import type { RequestWithUser } from 'src/auth/types';

@Controller('user')
@UseGuards(JwtGuard)
@ApiTags('User')
@ApiBearerAuth()
export class UserController {
  constructor(private userService: UserService) {}

  @Get()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'List users with pagination (admin only)' })
  @ApiOkResponse({ description: 'Paginated user list' })
  @ApiUnauthorizedResponse({
    description: 'Missing token or insufficient permissions',
  })
  getUsers(@Query() query: GetUserDto) {
    return this.userService.findAll(query);
  }

  @Get('search/account')
  @Serialize(PublicUserDto)
  @ApiOperation({
    summary: 'Search a user by exact accountId for friend adding',
  })
  @ApiOkResponse({ description: 'Matched user or null', type: PublicUserDto })
  searchUserByAccountId(
    @Query('accountId') accountId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.userService.findByExactAccountId(accountId, req.user.userId);
  }

  @Post()
  @UseGuards(AdminGuard)
  @Serialize(PublicUserDto)
  @ApiOperation({ summary: 'Create a user (admin only)' })
  @ApiBody({ type: CreateUserDto })
  @ApiOkResponse({ description: 'Created user', type: PublicUserDto })
  addUser(@Body() dto: CreateUserDto) {
    return this.userService.create({
      accountId: dto.accountId,
      password: dto.password,
      nickname: dto.nickname,
    });
  }

  @Post('vip-levels')
  // POST 但语义是只读查询:显式 200(默认 201 会与 @ApiOkResponse 的 200 契约冲突)。
  @HttpCode(HttpStatus.OK)
  // 无全局 ThrottlerGuard,给这个前端可高频调用(IM 补水/重连)的批量端点单独限流。
  // 用 UserThrottlerGuard 按已认证用户计数(而非 IP)——否则同一 NAT/代理后的用户共享额度,
  // 一小波重连会让无辜用户吃 429;防止重连风暴或单客户端把每次最多 200 个 id 的查询打爆。
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Batch lookup vipLevel by user ids (for name-effect rendering)',
  })
  @ApiOkResponse({
    description: 'Map of userId to vipLevel',
    // Promise<Record<string, number>> 的泛型在运行时被擦除，反射只看到 Promise，
    // 不显式给 schema 的话生成的 OpenAPI 该响应没有对象/值类型，客户端无法建模。
    schema: {
      type: 'object',
      additionalProperties: { type: 'integer' },
      example: { 'user-a-id': 3, 'user-b-id': 4 },
    },
  })
  getVipLevels(@Body() dto: VipLevelsDto): Promise<Record<string, number>> {
    return this.userService.getVipLevels(dto.ids);
  }

  @Get('/:id')
  @Serialize(ProfileUserDto)
  @ApiOperation({ summary: 'Get a user by id' })
  @ApiOkResponse({ description: 'User details', type: ProfileUserDto })
  getUser(@Param('id', ParseUUIDPipe) id: string, @Req() req: RequestWithUser) {
    return this.userService.findOne(id, req.user.userId);
  }

  @Patch('/:id')
  @Serialize(SelfUserDto)
  @ApiOperation({ summary: 'Update a user (self or admin)' })
  @ApiOkResponse({ description: 'Updated user', type: SelfUserDto })
  updateUser(
    @Body() dto: UpdateUserDto,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ) {
    if (id !== req.user?.userId && req.user?.role !== Role.Admin) {
      throw new ForbiddenException({
        message: 'You can only update your own profile',
        errorCode: UserErrorCode.UpdateOwnOnly,
      });
    }
    return this.userService.update(id, dto);
  }

  // 账号状态变更只保留 PATCH /admin/users/:id/status 一条路径（#121）：这里原来
  // 那条 admin 路由不写审计、原因可省、删除也不需要确认账号 ID，留着就是一个
  // 绕过审计与状态机的后门。

  @Delete('/:id')
  @Serialize(PublicUserDto)
  @ApiOperation({ summary: 'Delete a user (self or admin)' })
  @ApiOkResponse({ description: 'Deleted user', type: PublicUserDto })
  removeUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ) {
    if (id !== req.user?.userId && req.user?.role !== Role.Admin) {
      throw new ForbiddenException({
        message: 'You can only delete your own account',
        errorCode: UserErrorCode.DeleteOwnOnly,
      });
    }
    return this.userService.remove(id);
  }
}
