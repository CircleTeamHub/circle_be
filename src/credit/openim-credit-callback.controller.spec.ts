import {
  type CreditPolicyDecision,
  type CreditPolicyService,
} from './credit-policy.service';
import { OpenimCreditCallbackController } from './openim-credit-callback.controller';

describe('OpenimCreditCallbackController', () => {
  const policy = {
    checkOpenimSend: jest.fn(),
  };
  let controller: OpenimCreditCallbackController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new OpenimCreditCallbackController(
      policy as unknown as CreditPolicyService,
    );
  });

  it('rejects a single chat message when the sender is below the send threshold', async () => {
    policy.checkOpenimSend.mockResolvedValue(blockedDecision());

    await expect(
      controller.handleBeforeSendSingle({ sendID: 'sender-im-id' }),
    ).resolves.toEqual({
      actionCode: 0,
      errCode: 5001,
      errMsg: '信誉值低于 60，暂时无法发送消息',
      errDlt: 'LOW_CREDIT_SCORE',
      nextCode: 1,
    });
    expect(policy.checkOpenimSend).toHaveBeenCalledWith('sender-im-id');
  });

  it('allows a group chat message when the sender passes credit policy', async () => {
    policy.checkOpenimSend.mockResolvedValue({
      allowed: true,
      code: null,
      currentScore: 60,
      minScore: 60,
      message: null,
    });

    await expect(
      controller.handleBeforeSendGroup({ sendID: 'sender-im-id' }),
    ).resolves.toEqual({
      actionCode: 0,
      errCode: 0,
      errMsg: '',
      errDlt: '',
      nextCode: 0,
    });
  });

  it('fails open when OpenIM sends a user id not owned by app users', async () => {
    policy.checkOpenimSend.mockResolvedValue(null);

    await expect(
      controller.handleBeforeSendSingle({ sendID: 'temp-guest-id' }),
    ).resolves.toEqual({
      actionCode: 0,
      errCode: 0,
      errMsg: '',
      errDlt: '',
      nextCode: 0,
    });
  });

  it('fails open for malformed callback payloads so OpenIM availability is preserved', async () => {
    await expect(controller.handleBeforeSendSingle({})).resolves.toEqual({
      actionCode: 0,
      errCode: 0,
      errMsg: '',
      errDlt: '',
      nextCode: 0,
    });
    expect(policy.checkOpenimSend).not.toHaveBeenCalled();
  });
});

function blockedDecision(): CreditPolicyDecision {
  return {
    allowed: false,
    code: 'LOW_CREDIT_SCORE',
    currentScore: 59,
    minScore: 60,
    message: '信誉值低于 60，暂时无法发送消息',
  };
}
