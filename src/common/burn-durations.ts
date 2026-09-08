/**
 * 阅后即焚时长阶梯 —— 后端唯一事实源,与前端 `src/chat-core/burn-durations.ts`
 * 逐值镜像(前端 test/burn-duration-contract.test.js 双仓并排时会逐项比对)。
 *
 * 在这之前会话级焚毁(30秒/5分/1时/1天/7天)与全局隐私设置的自毁**天数**
 * (1/2/7/30 天)各有一张表,说的却是同一个功能:「30 秒」只在单会话里存在,
 * 「30 天」只在全局里存在。现在两处共用这一张。
 */
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** 「1 个月」按 30 天算:焚毁窗口是个时长,不跟自然月的 28/30/31 天走。 */
const MONTH = 30 * DAY;

/** 关闭焚毁。会话级存 null 或 0,全局设置存 0。 */
export const BURN_DURATION_OFF = 0;

export const BURN_DURATION_CHOICES = [
  BURN_DURATION_OFF,
  MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  6 * HOUR,
  DAY,
  2 * DAY,
  3 * DAY,
  4 * DAY,
  5 * DAY,
  6 * DAY,
  WEEK,
  2 * WEEK,
  3 * WEEK,
  MONTH,
] as const;

export type BurnDurationSec = (typeof BURN_DURATION_CHOICES)[number];

export function isBurnDurationChoice(
  seconds: unknown,
): seconds is BurnDurationSec {
  return (
    typeof seconds === 'number' &&
    (BURN_DURATION_CHOICES as readonly number[]).includes(seconds)
  );
}
