import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  PrivacySettingsDto,
  UpdatePrivacySettingsDto,
} from './privacy-settings.dto';
import { PrivacySettingsService } from './privacy-settings.service';

@ApiTags('Privacy')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('privacy')
export class PrivacySettingsController {
  constructor(private readonly privacySettings: PrivacySettingsService) {}

  @Get('settings')
  @ApiOkResponse({ type: PrivacySettingsDto })
  getSettings(@Req() req: RequestWithUser): Promise<PrivacySettingsDto> {
    return this.privacySettings.getSettings(req.user.userId);
  }

  @Patch('settings')
  @ApiOkResponse({ type: PrivacySettingsDto })
  updateSettings(
    @Req() req: RequestWithUser,
    @Body() dto: UpdatePrivacySettingsDto,
  ): Promise<PrivacySettingsDto> {
    return this.privacySettings.updateSettings(req.user.userId, dto);
  }
}
