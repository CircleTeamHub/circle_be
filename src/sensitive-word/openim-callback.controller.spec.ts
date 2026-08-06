import { NotFoundException } from '@nestjs/common';
import { OpenimCallbackController } from './openim-callback.controller';
import { SENSITIVE_WORD_BLOCKED_ERR_CODE } from './sensitive-word.constants';

const TOKEN = 'callback-token-0123456789abcdef';

const textBody = (text: string, overrides: Record<string, unknown> = {}) => ({
  callbackCommand: 'callbackBeforeSendSingleMsg',
  sendID: 'user-1',
  clientMsgID: 'cmsg-1',
  contentType: 101,
  sessionType: 1,
  content: JSON.stringify({ content: text }),
  ...overrides,
});

const ALLOW = {
  actionCode: 0,
  errCode: 0,
  errMsg: '',
  errDlt: '',
  nextCode: 0,
};

describe('OpenimCallbackController', () => {
  let controller: OpenimCallbackController;
  const check = jest.fn();
  const service = { check } as any;

  const buildController = (envToken: string | undefined) => {
    const config = { get: jest.fn().mockReturnValue(envToken) } as any;
    return new OpenimCallbackController(service, config);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    check.mockReturnValue({ blocked: false });
    controller = buildController(TOKEN);
  });

  it('token 不匹配 → 404，且不做判定', () => {
    expect(() =>
      controller.beforeSendSingleMsg('wrong-token', textBody('hi')),
    ).toThrow(NotFoundException);
    expect(check).not.toHaveBeenCalled();
  });

  it('未配置 OPENIM_CALLBACK_TOKEN → 一律 404', () => {
    const disabled = buildController(undefined);
    expect(() => disabled.beforeSendSingleMsg(TOKEN, textBody('hi'))).toThrow(
      NotFoundException,
    );
  });

  it('文本消息未命中 → 放行响应', () => {
    expect(
      controller.beforeSendSingleMsg(TOKEN, textBody('今晚吃什么')),
    ).toEqual(ALLOW);
    expect(check).toHaveBeenCalledWith('今晚吃什么');
  });

  it('文本消息命中 → nextCode=1 拒绝且带专属 errCode', () => {
    check.mockReturnValue({ blocked: true, word: '赌博' });
    const resp = controller.beforeSendSingleMsg(TOKEN, textBody('来赌博'));
    expect(resp).toMatchObject({
      actionCode: 0,
      errCode: SENSITIVE_WORD_BLOCKED_ERR_CODE,
      nextCode: 1,
    });
    expect(resp.errMsg).not.toContain('赌博'); // 不回显词条，防探测词库
  });

  it('@消息（106）检 text 字段', () => {
    check.mockReturnValue({ blocked: true, word: 'casino' });
    const body = textBody('', {
      contentType: 106,
      content: JSON.stringify({ text: 'go casino', atUserList: ['u2'] }),
    });
    expect(controller.beforeSendSingleMsg(TOKEN, body).nextCode).toBe(1);
    expect(check).toHaveBeenCalledWith('go casino');
  });

  it('引用消息（114）只检新输入的 text', () => {
    const body = textBody('', {
      contentType: 114,
      content: JSON.stringify({
        text: '你说得对',
        quoteMessage: { contentType: 101, textElem: { content: '来赌博' } },
      }),
    });
    expect(controller.beforeSendSingleMsg(TOKEN, body)).toEqual(ALLOW);
    expect(check).toHaveBeenCalledWith('你说得对');
  });

  it('非文本类消息（图片 102）直接放行，不做判定', () => {
    const body = textBody('', {
      contentType: 102,
      content: '{"sourcePicture":{}}',
    });
    expect(controller.beforeSendSingleMsg(TOKEN, body)).toEqual(ALLOW);
    expect(check).not.toHaveBeenCalled();
  });

  it('content 不是合法 JSON → fail-open 放行', () => {
    const body = textBody('', { content: 'not-json{{{' });
    expect(controller.beforeSendSingleMsg(TOKEN, body)).toEqual(ALLOW);
    expect(check).not.toHaveBeenCalled();
  });

  it('text 字段非字符串 → fail-open 放行', () => {
    const body = textBody('', { content: JSON.stringify({ content: 42 }) });
    expect(controller.beforeSendSingleMsg(TOKEN, body)).toEqual(ALLOW);
    expect(check).not.toHaveBeenCalled();
  });

  it('群聊回调同样拦截', () => {
    check.mockReturnValue({ blocked: true, word: '赌博' });
    const body = textBody('来赌博', {
      callbackCommand: 'callbackBeforeSendGroupMsgCommand',
      sessionType: 3,
      groupID: 'g-1',
    });
    expect(controller.beforeSendGroupMsg(TOKEN, body).nextCode).toBe(1);
  });

  // 路由末段 = OpenIM callbackCommand 常量原文（带 Command 后缀）。写错会 404，
  // 而 OpenIM 把 404 JSON 解析成全零响应 = 静默放行一切 —— 本地实测踩过的坑。
  it('路由路径与 OpenIM callbackCommand 常量逐字一致', () => {
    expect(Reflect.getMetadata('path', controller.beforeSendSingleMsg)).toBe(
      ':token/callbackBeforeSendSingleMsgCommand',
    );
    expect(Reflect.getMetadata('path', controller.beforeSendGroupMsg)).toBe(
      ':token/callbackBeforeSendGroupMsgCommand',
    );
  });
});
