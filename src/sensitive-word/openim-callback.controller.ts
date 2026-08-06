import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { RawResponse } from 'src/decorators/raw-response.decorator';
import { SensitiveWordService } from './sensitive-word.service';
import {
  allowResponse,
  blockResponse,
  extractModeratableText,
  type OpenimBeforeSendCallbackBody,
  type OpenimCallbackResponse,
} from './sensitive-word.constants';

/**
 * OpenIM before-send webhook（发消息前置回调）。
 *
 * OpenIM 侧配置 webhooks url = <base>/api/v1/openim/callback/<token>，
 * 服务器会 POST 到 <url>/<callbackCommand>，故路由末段是具体命令名。
 * 端点无 JWT（调用方是 OpenIM server），靠 URL token（≥24 字符随机串，
 * 常量时间比较）鉴权；token 不符或未配置一律 404，不暴露端点存在。
 *
 * ⚠️ 可用性契约：OpenIM v3.8.3 的 before-send 回调失败会直接导致消息
 * 发送失败（failedContinue 配置未在该路径生效），所以本控制器：
 * 1) 热路径零 IO（SensitiveWordService.check 是内存 trie）；
 * 2) 任何解析异常 fail-open 放行；
 * 3) 永远返回 200 + 协议 JSON，不抛 5xx。
 */
@ApiExcludeController()
@Controller('openim/callback')
export class OpenimCallbackController {
  private readonly logger = new Logger(OpenimCallbackController.name);
  private readonly tokenDigest: Buffer | null;

  constructor(
    private readonly sensitiveWords: SensitiveWordService,
    config: ConfigService,
  ) {
    const token = config.get<string>('OPENIM_CALLBACK_TOKEN') ?? '';
    this.tokenDigest = token ? sha256(token) : null;
  }

  // 路由末段 = OpenIM callbackCommand 常量原文（callbackstruct/constant.go），
  // 注意带 "Command" 后缀 —— 写错会 404，而 OpenIM 会把 Nest 的 404 JSON 解析成
  // 全零 CommonCallbackResp = 静默放行一切（已在本地实测踩过）。
  @Post(':token/callbackBeforeSendSingleMsgCommand')
  @HttpCode(HttpStatus.OK)
  @RawResponse() // OpenIM 只认顶层 actionCode/nextCode，不能包 {code,message,data} 信封
  beforeSendSingleMsg(
    @Param('token') token: string,
    @Body() body: OpenimBeforeSendCallbackBody,
  ): OpenimCallbackResponse {
    return this.moderate(token, body);
  }

  @Post(':token/callbackBeforeSendGroupMsgCommand')
  @HttpCode(HttpStatus.OK)
  @RawResponse()
  beforeSendGroupMsg(
    @Param('token') token: string,
    @Body() body: OpenimBeforeSendCallbackBody,
  ): OpenimCallbackResponse {
    return this.moderate(token, body);
  }

  private moderate(
    token: string,
    body: OpenimBeforeSendCallbackBody,
  ): OpenimCallbackResponse {
    this.assertToken(token);

    const text = extractModeratableText(body.contentType, body.content);
    if (text === null) return allowResponse();

    const verdict = this.sensitiveWords.check(text);
    if (!verdict.blocked) return allowResponse();

    // 只记元数据 + 命中词，绝不落消息正文（正文是全 app 最敏感数据）。
    this.logger.warn(
      `敏感词拦截 word=${verdict.word} sendID=${body.sendID ?? ''} ` +
        `clientMsgID=${body.clientMsgID ?? ''} contentType=${body.contentType} ` +
        `command=${body.callbackCommand ?? ''}`,
    );
    return blockResponse();
  }

  private assertToken(token: string): void {
    if (!this.tokenDigest || !token) {
      throw new NotFoundException();
    }
    const provided = sha256(token);
    if (!timingSafeEqual(provided, this.tokenDigest)) {
      throw new NotFoundException();
    }
  }
}

/** 定长摘要后再比较：timingSafeEqual 要求等长输入，顺带不留明文 token 在内存对象上。 */
function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
