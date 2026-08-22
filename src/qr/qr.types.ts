/** 二维码令牌 REST 面的响应形状(前端 src/services/api/qr.ts 按此对齐)。 */

export type QrTokenTypeDto = 'USER' | 'GROUP' | 'CIRCLE' | 'LOGIN';

/** POST /qr/tokens:签发(或复用仍在有效窗口内的)令牌。 */
export interface QrTokenDto {
  token: string;
  type: QrTokenTypeDto;
  /** USER 名片码长效,置 null;GROUP/CIRCLE 为 ISO 时间(微信同款 7 天)。 */
  expiresAt: string | null;
}

/** GET /qr/tokens/:token:扫码落地页预览。 */
export interface QrResolveDto {
  type: QrTokenTypeDto;
  /** USER=用户 id;GROUP=会话 id;CIRCLE=圈子 id。 */
  targetId: string;
  name: string;
  avatarUrl: string | null;
  /** GROUP=在座人数;CIRCLE=圈子人数;USER 无此概念。 */
  memberCount: number | null;
  issuerNickname: string;
  expiresAt: string | null;
  /** 扫到自己的名片 / 已在群里 / 已在圈子里:落地页据此换按钮。 */
  viewerState: 'SELF' | 'ALREADY_IN' | 'FRIEND' | 'NONE';
  /** LOGIN preview only: server-derived browser/OS and a comparison code. */
  requestDevice?: string;
  verificationCode?: string;
}

/** POST /qr/tokens/:token/join。 */
export interface QrJoinResultDto {
  type: QrTokenTypeDto;
  /** GROUP:入座后的会话 id,前端直接进聊天。 */
  conversationId?: string;
  /** CIRCLE:快照语义直接入圈 → JOINED;严格模式建了担保邀请单 → PENDING。 */
  circleId?: string;
  status: 'JOINED' | 'PENDING';
}
