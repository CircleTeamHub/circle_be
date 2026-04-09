import {
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  ForbiddenException,
  UseGuards,
  Req,
} from '@nestjs/common';
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
import { PublicUserDto, SelfUserDto } from './dto/public-user.dto';
import { Role } from 'src/enum/roles.enum';

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
  @Serialize(PublicUserDto)
  @ApiOperation({ summary: 'Get a user by id' })
  @ApiOkResponse({ description: 'User details', type: PublicUserDto })
  getUser(@Param('id') id: string) {
    return this.userService.findOne(id);
  }

  @Patch('/:id')
  @Serialize(SelfUserDto)
  @ApiOperation({ summary: 'Update a user (self or admin)' })
  @ApiOkResponse({ description: 'Updated user', type: SelfUserDto })
  updateUser(
    @Body() dto: UpdateUserDto,
    @Param('id') id: string,
    @Req() req: any,
  ) {
    if (id !== req.user?.userId && req.user?.role !== Role.Admin) {
      throw new ForbiddenException('You can only update your own profile');
    }
    return this.userService.update(id, dto);
  }

  @Patch('/:id/status')
  @UseGuards(AdminGuard)
  @Serialize(PublicUserDto)
  @ApiOperation({ summary: 'Update user status (admin only)' })
  @ApiBody({ type: UpdateUserStatusDto })
  @ApiOkResponse({ description: 'Updated user', type: PublicUserDto })
  updateUserStatus(@Param('id') id: string, @Body() dto: UpdateUserStatusDto) {
    return this.userService.updateStatus(id, dto.status);
  }

  @Delete('/:id')
  @Serialize(PublicUserDto)
  @ApiOperation({ summary: 'Delete a user (self or admin)' })
  @ApiOkResponse({ description: 'Deleted user', type: PublicUserDto })
  removeUser(@Param('id') id: string, @Req() req: any) {
    if (id !== req.user?.userId && req.user?.role !== Role.Admin) {
      throw new ForbiddenException('You can only delete your own account');
    }
    return this.userService.remove(id);
  }
}
