import {
  BadRequestException,
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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserService } from './user.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { VipLevelsDto } from './dto/vip-levels.dto';
import { AppearancesDto } from './dto/appearances.dto';
import type { PublicUserAppearance } from 'src/avatar-frame/avatar-frame.service';
import { JwtGuard } from 'src/guards/jwt.guard';
import { Serialize } from 'src/decorators/serialize.decorator';
import {
  ProfileUserDto,
  PublicUserDto,
  SelfUserDto,
} from './dto/public-user.dto';
import { Role } from 'src/enum/roles.enum';
import type { RequestWithUser } from 'src/auth/types';

// accountId 走裸 @Query()，重复参数（?accountId=a&accountId=b）会以 string[] 到达，
// service 里的 .trim() 直接 TypeError → 500 + Sentry 噪音。真实账号最长 32 位
// （ACCOUNT_ID_PATTERN），64 已留足余量，再长的只可能是探测/误用，直接 400。
const ACCOUNT_ID_QUERY_MAX_LENGTH = 64;

@Controller('user')
@UseGuards(JwtGuard)
@ApiTags('User')
@ApiBearerAuth()
export class UserController {
  constructor(private userService: UserService) {}

  // GET /user（分页列表）与 POST /user（建号）已删除：管理台只用 /admin/users。
  // 旧列表把每个用户的邮箱/手机/微信/QQ/生日明文交给任何 role=ADMIN 的 token，
  // 不经隐私开关也不写 AdminAuditLog，留着就是一条绕过脱敏与审计的后门。

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
    if (
      typeof accountId !== 'string' ||
      accountId.length > ACCOUNT_ID_QUERY_MAX_LENGTH
    ) {
      throw new BadRequestException(
        `accountId must be a single string of at most ${ACCOUNT_ID_QUERY_MAX_LENGTH} characters`,
      );
    }
    return this.userService.findByExactAccountId(accountId, req.user.userId);
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

  @Post('appearances')
  @HttpCode(HttpStatus.OK)
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Batch lookup effective VIP and avatar-frame appearance',
  })
  @ApiOkResponse({
    description: 'Map keyed by each matched caller-provided alias',
    schema: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['vipLevel', 'avatarFrame'],
        properties: {
          vipLevel: { type: 'integer', minimum: 0, maximum: 4 },
          avatarFrame: {
            type: 'object',
            nullable: true,
            required: ['id', 'key', 'name', 'imageUrl'],
            properties: {
              id: { type: 'string' },
              key: { type: 'string' },
              name: { type: 'string' },
              imageUrl: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
  })
  getAppearances(
    @Body() dto: AppearancesDto,
  ): Promise<Record<string, PublicUserAppearance>> {
    return this.userService.getAppearances(dto.ids);
  }

  @Get('/:id')
  @Serialize(ProfileUserDto)
  @ApiOperation({ summary: 'Get a user by id' })
  @ApiOkResponse({ description: 'User details', type: ProfileUserDto })
  getUser(@Param('id', ParseUUIDPipe) id: string, @Req() req: RequestWithUser) {
    return this.userService.findOne(id, req.user.userId);
  }

  @Patch('/:id')
  // 这是全站最重的写：一次调用会失效并重算 profile summary 缓存、向订阅者广播。
  // 之前它一道路由级限流都没有，只剩 300 次/分钟/IP
  // 的全局兜底 —— 一个脚本循环改昵称就能把广播打满。
  // 按账号而不是 IP 计数（UserThrottlerGuard），免得运营商 NAT 后的用户互相牵连。
  // 30 次/分钟对真人编辑资料绰绰有余，与本文件其它写接口保持一致。
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Serialize(SelfUserDto)
  @ApiOperation({ summary: 'Update a user (self only)' })
  @ApiOkResponse({ description: 'Updated user', type: SelfUserDto })
  updateUser(
    @Body() dto: UpdateUserDto,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ) {
    // 只能改自己：此前 role=ADMIN 的 token（不分 audience）能改任何人的资料，
    // 且不写 AdminAuditLog —— #121 已因同样的理由删掉同级的 admin status 路由。
    if (id !== req.user?.userId) {
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
  @ApiOperation({ summary: 'Delete the current user account' })
  @ApiOkResponse({ description: 'Deleted user', type: PublicUserDto })
  removeUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ) {
    if (req.user?.role === Role.Admin) {
      throw new ForbiddenException({
        message: 'Admins must use the audited admin status endpoint',
        errorCode: UserErrorCode.DeleteOwnOnly,
      });
    }
    if (id !== req.user?.userId) {
      throw new ForbiddenException({
        message: 'You can only delete your own account',
        errorCode: UserErrorCode.DeleteOwnOnly,
      });
    }
    return this.userService.remove(id);
  }
}
