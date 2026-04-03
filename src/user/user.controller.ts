import {
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  UnauthorizedException,
  UseGuards,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserService } from './user.service';
import { GetUserDto } from './dto/get-user.dto';
import { CreateUserPipe } from './pipes/create-user.pipe';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { Serialize } from 'src/decorators/serialize.decorator';
import { PublicUserDto } from './dto/public-user.dto';
import { Role } from 'src/enum/roles.enum';

@Controller('user')
@UseGuards(JwtGuard)
@ApiTags('User')
@ApiBearerAuth()
export class UserController {
  constructor(private userService: UserService) {}

  @Get('/profile')
  @ApiOperation({ summary: 'Get a user profile by id' })
  @ApiQuery({ name: 'id', required: true, type: String })
  @ApiOkResponse({ description: 'User profile', type: PublicUserDto })
  getUserProfile(@Query('id') id: string): any {
    return this.userService.findProfile(id);
  }

  @Get('/logs')
  getUserLogs(): any {
    return this.userService.findUserLogs('');
  }

  @Get('/logsByGroup')
  async getLogsByGroup(): Promise<any> {
    return this.userService.findLogsByGroup('');
  }

  @Get()
  @UseGuards(AdminGuard)
  @Serialize(PublicUserDto)
  @ApiOperation({ summary: 'List users (admin only)' })
  @ApiOkResponse({
    description: 'User list',
    type: PublicUserDto,
    isArray: true,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing token or insufficient permissions',
  })
  getUsers(@Query() query: GetUserDto): any {
    return this.userService.findAll(query);
  }

  @Post()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Create a user (admin only)' })
  @ApiBody({ type: CreateUserDto })
  @ApiOkResponse({ description: 'Created user', type: PublicUserDto })
  addUser(@Body(CreateUserPipe) dto: CreateUserDto): any {
    return this.userService.create({
      username: dto.username,
      password: dto.password,
      nickname: dto.nickname,
    });
  }

  @Get('/:id')
  @ApiOperation({ summary: 'Get a user by id' })
  @ApiOkResponse({ description: 'User details', type: PublicUserDto })
  getUser(@Param('id') id: string): any {
    return this.userService.findOne(id);
  }

  @Patch('/:id')
  @ApiOperation({ summary: 'Update the current user' })
  @ApiOkResponse({ description: 'Updated user', type: PublicUserDto })
  updateUser(
    @Body() dto: UpdateUserDto,
    @Param('id') id: string,
    @Req() req: any,
  ): any {
    if (id !== req.user?.userId) {
      throw new UnauthorizedException();
    }
    return this.userService.update(id, dto);
  }

  @Delete('/:id')
  @ApiOperation({ summary: 'Delete the current user or delete as admin' })
  @ApiOkResponse({ description: 'Deleted user', type: PublicUserDto })
  removeUser(@Param('id') id: string, @Req() req: any): any {
    if (id !== req.user?.userId && req.user?.role !== Role.Admin) {
      throw new UnauthorizedException();
    }
    return this.userService.remove(id);
  }
}
