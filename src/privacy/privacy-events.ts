import { EventEmitter } from 'node:events';

/**
 * 隐私设置变更的进程内事件。
 *
 * PrivacySettingsModule 不能反向依赖 ChatModule(ChatModule 已经依赖它),
 * 所以用一个很小的事件桥把「设置已提交」交给聊天广播层处理。
 */
export interface PresenceVisibilityChangedEvent {
  userId: string;
  /** 翻转后的值:false = 从此对所有人隐藏在线状态与最近在线时间。 */
  visible: boolean;
  /** 该用户当前在座的全部会话 —— 上下线广播的收件面。 */
  conversationIds: string[];
  /** 与之互相拉黑的人;广播侧要剔掉,与网关上下线广播同一条规则。 */
  excludeUserIds: string[];
}

export const privacySettingsEvents = new EventEmitter();

export const PRESENCE_VISIBILITY_CHANGED = 'presence-visibility-changed';
