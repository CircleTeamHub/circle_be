/**
 * ⚠️ 跨仓数字契约：这个 errCode 会原样穿透 OpenIM（回调 resp → RPC error →
 * 客户端 sendMessage 失败），circle-im 前端按它识别「敏感词被拒」并弹提示
 * （src/im/error-codes.ts 的 OPENIM_SENSITIVE_WORD_BLOCKED_CODE）。两边必须
 * 同步改。选在 73xxx 段避开 OpenIM 自有码域（500/1xxx/1xxxx/2xxxx/8xxxx/9xxxx）。
 */
export const SENSITIVE_WORD_BLOCKED_ERR_CODE = 73001;

/** OpenIM contentType → 待检文本字段。仅这三类含用户自由输入文本。 */
export const MODERATED_CONTENT_TYPES = {
  /** 纯文本：content 是 {"content": "..."} */
  TEXT: 101,
  /** @消息：content 是 {"text": "...", "atUserList": [...]} */
  AT_TEXT: 106,
  /** 引用回复：content 是 {"text": "...", "quoteMessage": {...}}；被引内容发出时已检过 */
  QUOTE: 114,
} as const;

/** OpenIM before-send 回调载荷里本服务关心的字段（CommonCallbackReq 子集）。 */
export interface OpenimBeforeSendCallbackBody {
  callbackCommand?: string;
  sendID?: string;
  clientMsgID?: string;
  recvID?: string;
  groupID?: string;
  sessionType?: number;
  contentType?: number;
  content?: string;
}

export interface OpenimCallbackResponse {
  actionCode: number;
  errCode: number;
  errMsg: string;
  errDlt: string;
  nextCode: number;
}

/** 放行：nextCode=0。 */
export function allowResponse(): OpenimCallbackResponse {
  return { actionCode: 0, errCode: 0, errMsg: '', errDlt: '', nextCode: 0 };
}

/**
 * 拒绝：actionCode=0 + nextCode=1 才会让 OpenIM 把 errCode 作为发送失败
 * 抛回客户端（见 open-im-server callbackstruct/common.go 的 Parse()）。
 * errMsg 不带命中词条 —— 回显词条等于给刷子提供词库探针。
 */
export function blockResponse(): OpenimCallbackResponse {
  return {
    actionCode: 0,
    errCode: SENSITIVE_WORD_BLOCKED_ERR_CODE,
    errMsg: 'message contains blocked words',
    errDlt: '',
    nextCode: 1,
  };
}

/**
 * 从回调载荷提取待检的用户输入文本；非文本类 / 载荷异常返回 null（放行）。
 * fail-open：解析失败宁可漏检也不误伤 —— 拦截的正确性优先级低于聊天可用性。
 */
export function extractModeratableText(
  contentType: number | undefined,
  content: string | undefined,
): string | null {
  if (typeof content !== 'string' || content.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const elem = parsed as Record<string, unknown>;

  switch (contentType) {
    case MODERATED_CONTENT_TYPES.TEXT:
      return typeof elem.content === 'string' ? elem.content : null;
    case MODERATED_CONTENT_TYPES.AT_TEXT:
    case MODERATED_CONTENT_TYPES.QUOTE:
      return typeof elem.text === 'string' ? elem.text : null;
    default:
      return null;
  }
}
