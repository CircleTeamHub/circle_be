import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreditPolicyService } from './credit-policy.service';
import { OpenimCallbackGuard } from './openim-callback.guard';

type OpenimBeforeSendPayload = {
  sendID?: unknown;
};

type OpenimCallbackResponse = {
  actionCode: number;
  errCode: number;
  errMsg: string;
  errDlt: string;
  nextCode: number;
};

const OPENIM_CALLBACK_ALLOW: OpenimCallbackResponse = {
  actionCode: 0,
  errCode: 0,
  errMsg: '',
  errDlt: '',
  nextCode: 0,
};

function openimCallbackDeny(message: string): OpenimCallbackResponse {
  return {
    actionCode: 0,
    errCode: 5001,
    errMsg: message,
    errDlt: 'LOW_CREDIT_SCORE',
    nextCode: 1,
  };
}

@ApiTags('OpenIM Callback')
@UseGuards(OpenimCallbackGuard)
@Controller('openim-callback')
export class OpenimCreditCallbackController {
  constructor(private readonly creditPolicyService: CreditPolicyService) {}

  @Post('callbackBeforeSendSingleMsgCommand')
  @ApiOperation({ summary: 'OpenIM before-send single message credit gate' })
  handleBeforeSendSingle(
    @Body() body: OpenimBeforeSendPayload,
  ): Promise<OpenimCallbackResponse> {
    return this.handleBeforeSend(body);
  }

  @Post('callbackBeforeSendGroupMsgCommand')
  @ApiOperation({ summary: 'OpenIM before-send group message credit gate' })
  handleBeforeSendGroup(
    @Body() body: OpenimBeforeSendPayload,
  ): Promise<OpenimCallbackResponse> {
    return this.handleBeforeSend(body);
  }

  private async handleBeforeSend(
    body: OpenimBeforeSendPayload,
  ): Promise<OpenimCallbackResponse> {
    if (typeof body.sendID !== 'string' || body.sendID.trim().length === 0) {
      return OPENIM_CALLBACK_ALLOW;
    }

    const decision = await this.creditPolicyService.checkOpenimSend(
      body.sendID,
    );
    if (!decision || decision.allowed) {
      return OPENIM_CALLBACK_ALLOW;
    }

    return openimCallbackDeny(
      decision.message ?? '信誉值不足，暂时无法发送消息',
    );
  }
}
