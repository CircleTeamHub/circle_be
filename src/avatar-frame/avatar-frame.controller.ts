import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  AvatarFrameInventoryDto,
  UpdateEquippedAvatarFrameDto,
} from './dto/avatar-frame.dto';
import { AvatarFrameService } from './avatar-frame.service';

@ApiTags('Avatar Frames')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('avatar-frames')
export class AvatarFrameController {
  constructor(private readonly avatarFrames: AvatarFrameService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get my available avatar frames' })
  @ApiOkResponse({ type: AvatarFrameInventoryDto })
  getMine(@Req() request: RequestWithUser) {
    return this.avatarFrames.getInventory(request.user.userId);
  }

  @Put('me/equipped')
  @ApiOperation({ summary: 'Equip or clear my avatar frame' })
  @ApiOkResponse({ type: AvatarFrameInventoryDto })
  updateEquipped(
    @Body() dto: UpdateEquippedAvatarFrameDto,
    @Req() request: RequestWithUser,
  ) {
    return this.avatarFrames.setEquipped(request.user.userId, dto.frameId);
  }
}
