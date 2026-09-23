import { AsyncLocalStorage } from 'node:async_hooks';

export interface OperationContext {
  readonly job: string;
  readonly runId: string;
}

const operationContext = new AsyncLocalStorage<OperationContext>();

export function runWithOperationContext<T>(
  context: OperationContext,
  run: () => T,
): T {
  return operationContext.run(context, run);
}

export function getOperationContext(): OperationContext | undefined {
  return operationContext.getStore();
}
