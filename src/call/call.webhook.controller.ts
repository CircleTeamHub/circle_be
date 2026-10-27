import { AnonymousAccess } from 'src/guards/anonymous-access.decorator';
import {
  BadRequestException,
  Controller,
  Headers,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { sanitizeLogText } from 'src/logging/log-sanitizer';
import { recordLiveKitWebhook } from 'src/metrics/call-metrics';
import { CallService, type LiveKitWebhookOutcome } from './call.service';
import { LiveKitCallService } from './livekit.service';

type RawBodyRequest = Request & { rawBody?: Buffer };
type VerifiedWebhookEvent = Awaited<
  ReturnType<LiveKitCallService['verifyWebhook']>
>;

@ApiTags('Calls')
@Controller('calls/livekit')
export class CallWebhookController {
  private readonly logger = new Logger(CallWebhookController.name);

  constructor(
    private readonly livekit: LiveKitCallService,
    private readonly callService: CallService,
  ) {}

  @AnonymousAccess('LiveKit signed webhook')
  @Post('webhook')
  async handleLiveKitWebhook(
    @Headers('authorization') authorization: string | undefined,
    @Req() req: RawBodyRequest,
  ) {
    if (!req.rawBody) {
      // 没有原始报文就无从验签：与签名不对同样记 rejected（rawBody 配置被关掉时
      // 所有回调都会落在这里，计数能让它被看见）。
      recordLiveKitWebhook('rejected');
      throw new BadRequestException('RAW_BODY_REQUIRED');
    }

    const event = await this.verify(req.rawBody, authorization);

    // 验签已过：之后的异常是我们自己的处理失败（多半是数据库），不是对方签名不对。
    // 回 500 让 LiveKit 重投 —— endLiveKitFinishedCall 是条件写，重投不会重复结束通话。
    // 只救得回「条件写之前或当时」的失败：条件写已经提交、之后的步骤才失败时，重投
    // 看到的是已结束的通话，结束留痕和计数不会补上。
    // 以前这里一律回 401，数据库一抖就把合法回调当成伪造请求丢掉。
    let outcome: LiveKitWebhookOutcome;
    try {
      outcome = await this.callService.handleLiveKitWebhook(event);
    } catch (error) {
      recordLiveKitWebhook('failed');
      this.logProcessingFailure(event, error);
      throw new InternalServerErrorException('LIVEKIT_WEBHOOK_FAILED', {
        cause: error,
      });
    }
    recordLiveKitWebhook(outcome);
    return { ok: true };
  }

  private async verify(
    rawBody: Buffer,
    authorization: string | undefined,
  ): Promise<VerifiedWebhookEvent> {
    try {
      return await this.livekit.verifyWebhook(
        rawBody.toString('utf8'),
        authorization,
      );
    } catch (error) {
      recordLiveKitWebhook('rejected');
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new UnauthorizedException('LIVEKIT_WEBHOOK_INVALID');
    }
  }

  /** 只记事件类型、房间名和错误本身；不记请求体与 Authorization。 */
  private logProcessingFailure(
    event: VerifiedWebhookEvent,
    error: unknown,
  ): void {
    const errorName = error instanceof Error ? error.name : 'NonError';
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(
      sanitizeLogText(
        `call.webhook_failed event=${event.event ?? 'unknown'} room=${
          event.room?.name ?? ''
        } error=${errorName}: ${message}`,
      ),
    );
  }
}
