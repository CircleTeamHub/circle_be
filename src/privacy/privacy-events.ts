import { EventEmitter } from 'node:events';

/**
 * 隐私设置变更的进程内事件。
 *
 * PrivacySettingsModule 不能反向依赖 ChatModule(ChatModule 已经依赖它),
 * 所以用一个很小的事件桥把「设置已提交」交给聊天广播层处理。
 */
export interface PresenceVisibilityChangedEvent {
  userId: string;
  /**
   * 该用户当前在座的全部会话 —— 上下线广播的收件面。
   *
   * 刻意**不**带翻转后的值:两次快拨的事件准备是并发的,谁先 emit 不受事务提交
   * 顺序保护,带着值走就可能把 off→on 播成 on→off,留下「库里是开、客户端却被
   * 隐藏」或者反过来的泄漏。消费端现读当前设置,于是最后落地的那条必然是真值。
   */
  conversationIds: string[];
  /** 与之互相拉黑的人;广播侧要剔掉,与网关上下线广播同一条规则。 */
  excludeUserIds: string[];
}

export const privacySettingsEvents = new EventEmitter();

export const PRESENCE_VISIBILITY_CHANGED = 'presence-visibility-changed';
