import { Counter, Histogram, Registry } from 'prom-client';
import type { CallEndReason } from 'src/generated/prisma';

/**
 * 语音/视频通话的业务结果：发起、接听、结束与 LiveKit 回调。
 *
 * 通话链路此前只有日志：LiveKit 挂了、签 token 失败、回调验签失败、接通后秒断，
 * 指标和告警一片安静。circle_dependency_requests_total{dependency="livekit"} 只看得到
 * 建房/删房这两次 HTTP，看不到「打不出去 / 接不起来 / 一接通就断」。
 *
 * - circle_call_setups_total{kind,result}：每次通过入参校验、进入建单管线的发起一条。
 *   幂等回放不计；好友/权限/邀请名单这类入参拒绝不计（含锁内复检到的同类拒绝）。
 *   started / busy（任一方占线）/ livekit_unavailable（建房、签 token 失败或未配置）/
 *   failed（其余服务端错误，如建单事务失败）。
 * - circle_call_accepts_total{kind,result}：接听结果。too_late = 通话已结束或振铃已超时
 *   （含条件写落空），是正常竞态；failed 才是服务端问题。重复接听、「未被邀请」不计。
 * - circle_call_endings_total{kind,reason,answered}：每通结束的通话恰好一条 —— 六个终局
 *   写入都是条件写，只有赢家走到留痕。answered = 是否接通过（startedAt 有值）。
 * - circle_call_answered_duration_seconds{kind}：接通过的通话从接通到结束的时长。
 *   le="10" 读的是「接通后 10 秒内就断」的占比，桶边界不要随手改。
 * - circle_call_livekit_webhooks_total{result}：handled（已知通话的 room_finished 处理完）/
 *   ignored（验签通过，但不是 room_finished 或房间不认识）/ rejected（验签失败）/
 *   failed（验签通过但处理抛错，回 500 让 LiveKit 重投）。
 *
 * kind：direct = 1:1 呼叫，group = 群呼。
 */
export const CALL_KINDS = ['direct', 'group'] as const;
export const CALL_SETUP_RESULTS = [
  'started',
  'busy',
  'livekit_unavailable',
  'failed',
] as const;
export const CALL_ACCEPT_RESULTS = ['accepted', 'too_late', 'failed'] as const;
export const CALL_ENDING_REASONS = [
  'normal',
  'canceled',
  'all_left',
  'no_answer',
  'timeout',
  'network',
  'error',
] as const;
export const LIVEKIT_WEBHOOK_RESULTS = [
  'handled',
  'ignored',
  'rejected',
  'failed',
] as const;
/** 告警读 le="10"：改桶会让告警静默失效。 */
export const CALL_ANSWERED_DURATION_BUCKETS_SECONDS = [
  5, 10, 30, 60, 180, 600, 1800, 3600,
] as const;

export type CallKind = (typeof CALL_KINDS)[number];
export type CallSetupResult = (typeof CALL_SETUP_RESULTS)[number];
export type CallAcceptResult = (typeof CALL_ACCEPT_RESULTS)[number];
export type CallEndingReason = (typeof CALL_ENDING_REASONS)[number];
export type LiveKitWebhookResult = (typeof LIVEKIT_WEBHOOK_RESULTS)[number];

/**
 * Record 而不是 toLowerCase()：CallEndReason 新增取值时这里编译失败，
 * 逼着同时补上 CALL_ENDING_REASONS（否则新序列不会从 0 开始导出）。
 */
const ENDING_REASON_LABELS: Record<CallEndReason, CallEndingReason> = {
  NORMAL: 'normal',
  CANCELED: 'canceled',
  ALL_LEFT: 'all_left',
  NO_ANSWER: 'no_answer',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  ERROR: 'error',
};

export interface CallEnding {
  kind: CallKind;
  reason: CallEndReason;
  /** 接通时刻；null / undefined = 从未接通。 */
  startedAt: Date | null | undefined;
  endedAt: Date;
}

export interface CallMetrics {
  readonly registry: Registry;
  recordSetup(kind: CallKind, result: CallSetupResult): void;
  recordAccept(kind: CallKind, result: CallAcceptResult): void;
  recordEnding(ending: CallEnding): void;
  recordLiveKitWebhook(result: LiveKitWebhookResult): void;
}

export function createCallMetrics(): CallMetrics {
  const registry = new Registry();
  const setups = new Counter({
    name: 'circle_call_setups_total',
    help: 'Call setup attempts that passed request validation, by kind and result (idempotent replays excluded).',
    labelNames: ['kind', 'result'],
    registers: [registry],
  });
  const accepts = new Counter({
    name: 'circle_call_accepts_total',
    help: 'Call accept attempts by kind and result (too_late = call already ended or ring expired).',
    labelNames: ['kind', 'result'],
    registers: [registry],
  });
  const endings = new Counter({
    name: 'circle_call_endings_total',
    help: 'Ended calls, counted once per call, by kind, end reason and whether the call was ever answered.',
    labelNames: ['kind', 'reason', 'answered'],
    registers: [registry],
  });
  const answeredDuration = new Histogram({
    name: 'circle_call_answered_duration_seconds',
    help: 'Duration from answer to end for calls that were answered.',
    labelNames: ['kind'],
    buckets: [...CALL_ANSWERED_DURATION_BUCKETS_SECONDS],
    registers: [registry],
  });
  const webhooks = new Counter({
    name: 'circle_call_livekit_webhooks_total',
    help: 'LiveKit webhook deliveries by result (rejected = signature verification failed).',
    labelNames: ['result'],
    registers: [registry],
  });

  // 全部组合从 0 开始导出：increase() 不把新序列的首个样本当作从 0 起，
  // 不播种的话进程启动后的第一批失败不会进失败率。
  for (const kind of CALL_KINDS) {
    for (const result of CALL_SETUP_RESULTS) {
      setups.labels({ kind, result }).inc(0);
    }
    for (const result of CALL_ACCEPT_RESULTS) {
      accepts.labels({ kind, result }).inc(0);
    }
    for (const reason of CALL_ENDING_REASONS) {
      for (const answered of ['true', 'false']) {
        endings.labels({ kind, reason, answered }).inc(0);
      }
    }
    answeredDuration.zero({ kind });
  }
  for (const result of LIVEKIT_WEBHOOK_RESULTS) {
    webhooks.labels({ result }).inc(0);
  }

  return {
    registry,
    recordSetup(kind, result) {
      setups.inc({ kind, result });
    },
    recordAccept(kind, result) {
      accepts.inc({ kind, result });
    },
    recordEnding({ kind, reason, startedAt, endedAt }) {
      const answered = startedAt != null;
      endings.inc({
        kind,
        reason: ENDING_REASON_LABELS[reason],
        answered: answered ? 'true' : 'false',
      });
      if (!answered) return;
      const seconds = (endedAt.getTime() - startedAt.getTime()) / 1000;
      // 时钟回拨等导致的负值按 0 记；非有限值（坏日期）不观测，计数照记。
      if (Number.isFinite(seconds)) {
        answeredDuration.observe({ kind }, Math.max(0, seconds));
      }
    },
    recordLiveKitWebhook(result) {
      webhooks.inc({ result });
    },
  };
}

export const callMetrics = createCallMetrics();

// 调用点用下面这几个：计数失败不能改变通话的业务结果。

export function recordCallSetup(kind: CallKind, result: CallSetupResult): void {
  try {
    callMetrics.recordSetup(kind, result);
  } catch {
    // Metrics are best effort.
  }
}

export function recordCallAccept(
  kind: CallKind,
  result: CallAcceptResult,
): void {
  try {
    callMetrics.recordAccept(kind, result);
  } catch {
    // Metrics are best effort.
  }
}

export function recordCallEnding(ending: CallEnding): void {
  try {
    callMetrics.recordEnding(ending);
  } catch {
    // Metrics are best effort.
  }
}

export function recordLiveKitWebhook(result: LiveKitWebhookResult): void {
  try {
    callMetrics.recordLiveKitWebhook(result);
  } catch {
    // Metrics are best effort.
  }
}
