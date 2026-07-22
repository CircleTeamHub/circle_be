import { REVOKED_CLOSE_CODE, REVOKED_CLOSE_REASON } from './realtime.service';

/**
 * 跨仓契约钉死（#102）：会话撤销的 WS 关闭帧靠
 *   code === 1008 && reason === 'Session revoked'
 * 判终态，reason 字面量两仓各持一份：
 * - 本仓：src/realtime/realtime.service.ts
 * - 客户端：Circle_frontend/src/realtime/client.ts（对应 pin 测试
 *   test/realtime-revoked-contract.test.js）
 * 改这里的期望值 = 改契约本身，必须同步改前端字面量与其 pin 测试；
 * 否则撤销登出静默退化成重连环（跑到 JWT 过期），且两边测试都是绿的。
 */
describe('realtime revoked-close cross-repo contract (#102)', () => {
  it('pins the close code and reason byte-for-byte', () => {
    expect(REVOKED_CLOSE_CODE).toBe(1008);
    expect(REVOKED_CLOSE_REASON).toBe('Session revoked');
  });
});
