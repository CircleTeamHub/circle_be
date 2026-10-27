import type { S3Client } from '@aws-sdk/client-s3';
import type {
  DeserializeHandler,
  DeserializeHandlerArguments,
  DeserializeHandlerOutput,
  HandlerExecutionContext,
  MetadataBearer,
} from '@smithy/types';
import {
  recordDependencyRequest,
  type DependencyResult,
} from 'src/metrics/dependency-metrics';

type Record = (
  dependency: 'object_storage',
  operation: string,
  result: DependencyResult,
) => void;

/**
 * 给服务端用的 S3Client 挂上请求计数（circle_dependency_requests_total）。
 *
 * 挂在 deserialize 这一步、优先级 high：位于 SDK 自己的反序列化器外层，能看到
 * 它抛出的服务端错误（403/500 等），并且包住的就是真实的 HTTP 请求。预签名在
 * 更早的 finalizeRequest 步就被拦下返回，走不到这里 —— 那只是本地运算，不该
 * 算进依赖的成败。重试中间件在更外层，所以每一次重试都会各计一次。
 *
 * 只挂在后端自己读写用的 client 上；只用来预签名的 publicClient 不需要。
 */
export function instrumentObjectStorageClient(
  client: S3Client,
  record: Record = recordDependencyRequest,
): void {
  const safeRecord = (operation: string, result: DependencyResult) => {
    try {
      record('object_storage', operation, result);
    } catch {
      // Metrics are best effort and must not change the request outcome.
    }
  };

  client.middlewareStack.add(
    <Output extends MetadataBearer>(
      next: DeserializeHandler<object, Output>,
      context: HandlerExecutionContext,
    ) =>
      async (
        args: DeserializeHandlerArguments<object>,
      ): Promise<DeserializeHandlerOutput<Output>> => {
        const operation = operationName(context.commandName);
        try {
          const output = await next(args);
          safeRecord(operation, 'success');
          return output;
        } catch (error) {
          safeRecord(operation, classifyFailure(operation, error));
          throw error;
        }
      },
    {
      step: 'deserialize',
      priority: 'high',
      name: 'circleDependencyMetrics',
      override: true,
    },
  );
}

/** `PutObjectCommand` → `PutObject`。 */
function operationName(commandName: string | undefined): string {
  if (!commandName) return 'unknown';
  return commandName.endsWith('Command')
    ? commandName.slice(0, -'Command'.length)
    : commandName;
}

function classifyFailure(operation: string, error: unknown): DependencyResult {
  const value = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  } | null;
  const status = value?.$metadata?.httpStatusCode;
  // 桶不存在是配置错误，不是「对象不存在」那种正常结果。
  if (operation === 'HeadBucket' || value?.name === 'NoSuchBucket') {
    return 'failure';
  }
  return status === 404 ? 'not_found' : 'failure';
}
