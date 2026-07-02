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
} from '@nestjs/common';
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
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
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
  searchUserByAccountId(@Query('accountId') accountId: string) {
    return this.userService.findByExactAccountId(accountId);
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

  @Patch('/:id/status')
  @UseGuards(AdminGuard)
  @Serialize(PublicUserDto)
  @ApiOperation({ summary: 'Update user status (admin only)' })
  @ApiBody({ type: UpdateUserStatusDto })
  @ApiOkResponse({ description: 'Updated user', type: PublicUserDto })
  updateUserStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    return this.userService.updateStatus(id, dto.status);
  }

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
