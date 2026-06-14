import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CallService } from './call.service';
import { LiveKitCallService } from './livekit.service';

type RawBodyRequest = Request & { rawBody?: Buffer };

@ApiTags('Calls')
@Controller('calls/livekit')
export class CallWebhookController {
  constructor(
    private readonly livekit: LiveKitCallService,
    private readonly callService: CallService,
  ) {}

  @Post('webhook')
  async handleLiveKitWebhook(
    @Headers('authorization') authorization: string | undefined,
    @Req() req: RawBodyRequest,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException('RAW_BODY_REQUIRED');
    }

    try {
      const event = await this.livekit.verifyWebhook(
        req.rawBody.toString('utf8'),
        authorization,
      );
      await this.callService.handleLiveKitWebhook(event);
      return { ok: true };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new UnauthorizedException('LIVEKIT_WEBHOOK_INVALID');
    }
  }
}
