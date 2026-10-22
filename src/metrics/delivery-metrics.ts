import { Counter, Registry } from 'prom-client';

/**
 * 外部投递通道的结果计数：推送（Expo / JPush）与验证码邮件。
 *
 * 这两条通道失败时，业务代码只写 external_call_failed 日志 —— 推送凭证过期、
 * JPush 没配 key、SMTP 被限流时，指标和告警一片安静。PushDeliveryFailing /
 * EmailCodeSendFailing 读的就是这里。
 *
 * 推送按单 token 的结论计，Expo 的异步回执失败会再计一次（ok 回执不计）——
 * APNs/FCM 凭证失效、限流主要只出现在回执里，同步 ticket 照样是 ok：
 * - sent：provider 同步收下了；
 * - retryable：凭证、限流、网络、未配置这类会重试的失败；
 * - dead_token：令牌已死（卸载 App、注册 ID 失效）。这是正常流失，**不算**
 *   推送失败，单列出来就是为了让失败率不被它拉高；
 * - rejected：消息级终态（MessageTooBig 等），与 token 健康无关。
 */
export const PUSH_PROVIDERS = ['expo', 'jpush'] as const;
export const PUSH_DELIVERY_RESULTS = [
  'sent',
  'retryable',
  'dead_token',
  'rejected',
] as const;
export const EMAIL_CODE_SEND_RESULTS = [
  'success',
  'failure',
  'unavailable',
] as const;

export type PushProvider = (typeof PUSH_PROVIDERS)[number];
export type PushDeliveryResult = (typeof PUSH_DELIVERY_RESULTS)[number];
export type EmailCodeSendResult = (typeof EMAIL_CODE_SEND_RESULTS)[number];

export interface DeliveryMetrics {
  readonly registry: Registry;
  recordPushDelivery(provider: PushProvider, result: PushDeliveryResult): void;
  recordEmailCodeSend(result: EmailCodeSendResult): void;
}

export function createDeliveryMetrics(): DeliveryMetrics {
  const registry = new Registry();
  const pushDeliveries = new Counter({
    name: 'circle_push_deliveries_total',
    help: 'Push deliveries by provider and synchronous per-token outcome.',
    labelNames: ['provider', 'result'],
    registers: [registry],
  });
  const emailCodeSends = new Counter({
    name: 'circle_email_code_sends_total',
    help: 'Verification-code email sends by result (unavailable = no mailer configured).',
    labelNames: ['result'],
    registers: [registry],
  });

  // 全部组合从 0 开始导出：increase() 不把新序列的首个样本当作从 0 起，
  // 不播种的话进程启动后的第一批失败不会进失败率。
  for (const provider of PUSH_PROVIDERS) {
    for (const result of PUSH_DELIVERY_RESULTS) {
      pushDeliveries.labels({ provider, result }).inc(0);
    }
  }
  for (const result of EMAIL_CODE_SEND_RESULTS) {
    emailCodeSends.labels({ result }).inc(0);
  }

  return {
    registry,
    recordPushDelivery(provider, result) {
      pushDeliveries.inc({ provider, result });
    },
    recordEmailCodeSend(result) {
      emailCodeSends.inc({ result });
    },
  };
}

export const deliveryMetrics = createDeliveryMetrics();
