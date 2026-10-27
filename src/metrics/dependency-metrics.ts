import { Counter, Registry } from 'prom-client';

/**
 * 后端直接调用的外部依赖：对象存储（MinIO / COS）与 LiveKit。
 *
 * 两者失败时此前只写 external_call_failed 日志：存储凭证过期、桶策略把服务端
 * 读写拒掉、LiveKit 挂了，指标和告警一片安静。DependencyRequestsFailing 读这里。
 *
 * - success / failure：调用成败；
 * - not_found：对象不存在。「看一下在不在」是正常操作，算成失败的话存储审计
 *   一跑失败率就爆表；桶不存在则是配置错误，记 failure。
 *
 * 对象存储按真实发出的 HTTP 请求计（含 SDK 自动重试的每一次），本地预签名不算。
 * 客户端直传走预签名 URL，不经过后端，所以这里只覆盖服务端自己的读写。
 */
export const DEPENDENCIES = ['object_storage', 'livekit'] as const;
export const DEPENDENCY_RESULTS = ['success', 'not_found', 'failure'] as const;
const LIVEKIT_OPERATIONS = ['create_room', 'delete_room'] as const;

export type Dependency = (typeof DEPENDENCIES)[number];
export type DependencyResult = (typeof DEPENDENCY_RESULTS)[number];

export interface DependencyMetrics {
  readonly registry: Registry;
  record(
    dependency: Dependency,
    operation: string,
    result: DependencyResult,
  ): void;
}

/** 操作名来自 SDK 的命令名或代码里的字面量；仍做一次收口，标签基数绝不失控。 */
function boundedOperation(operation: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(operation) ? operation : 'other';
}

export function createDependencyMetrics(): DependencyMetrics {
  const registry = new Registry();
  const requests = new Counter({
    name: 'circle_dependency_requests_total',
    help: 'Backend requests to external dependencies (object storage, LiveKit) by operation and result.',
    labelNames: ['dependency', 'operation', 'result'],
    registers: [registry],
  });

  // 操作集合已知的从 0 开始导出（increase() 不把新序列首样本当作从 0 起）。
  // 对象存储的操作就是 SDK 命令名，随调用点增减，不在这里写死。
  for (const operation of LIVEKIT_OPERATIONS) {
    for (const result of DEPENDENCY_RESULTS) {
      requests.labels({ dependency: 'livekit', operation, result }).inc(0);
    }
  }

  return {
    registry,
    record(dependency, operation, result) {
      requests.inc({
        dependency,
        operation: boundedOperation(operation),
        result,
      });
    },
  };
}

export const dependencyMetrics = createDependencyMetrics();

/** 调用点用这个：计数失败不能改变调用结果。 */
export function recordDependencyRequest(
  dependency: Dependency,
  operation: string,
  result: DependencyResult,
): void {
  try {
    dependencyMetrics.record(dependency, operation, result);
  } catch {
    // Metrics are best effort.
  }
}
