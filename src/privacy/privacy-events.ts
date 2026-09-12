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

/**
 * 隐私设置变更的跨实例通知频道(载荷 = userId)。
 *
 * 「正在输入」的开关在网关里按用户缓存,只靠进程内事件的话,PATCH 落在实例 A
 * 而 socket 连在实例 B 时,B 的缓存要等 TTL 到期才追平 —— 那段窗口里 B 仍在
 * 转发本该被挡掉的 typing。沿用 SESSION_REVOCATION_CHANNEL 那套 publish /
 * psubscribe,让每个实例收到就丢掉自己那一份。
 */
export const PRIVACY_SETTINGS_CHANGED_CHANNEL = 'circle:privacy:changed';
