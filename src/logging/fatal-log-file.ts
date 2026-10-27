import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * uncaughtException 的最后一行，同步落进日志采集目录。
 *
 * 进程级兜底在 uncaughtException 之后限时刷新、随即 exit(1)。那一行原本只走
 * console.error：进不了 winston 的文件，也就进不了 Loki；而改走 winston 也不
 * 行 —— DailyRotateFile 是异步写，紧接着的 exit 会把它截断。所以这里绕开
 * winston，用 appendFileSync 同步追加一行与 winston 文件同形的 JSON。
 *
 * 目标由 createWinstonOptions 按「文件日志是否开启」配置：只写 stdout 的部署
 * 不落盘（stderr 本来就进容器日志）。文件名落在 Alloy 采集的
 * `application-*.log*` 范围内。每次崩溃只写一行，不需要轮转。
 */
interface FatalLogTarget {
  path: string;
  identifiers: Readonly<Record<string, string>>;
}

let target: FatalLogTarget | null = null;

export function configureFatalLogFile(
  path: string | null,
  identifiers: Readonly<Record<string, string>> = {},
): void {
  target = path ? { path, identifiers: { ...identifiers } } : null;
}

export function fatalLogFilePath(): string | null {
  return target?.path ?? null;
}

/**
 * 调用方只能传脱敏后的固定格式消息（见 unhandled-rejection-guard 的
 * safeDiagnostic）。写失败返回 false、绝不抛：它跑在退出路径上。
 */
export function writeFatalLogLine(message: string): boolean {
  if (!target) return false;
  try {
    mkdirSync(dirname(target.path), { recursive: true });
    appendFileSync(
      target.path,
      `${JSON.stringify({
        level: 'error',
        context: 'ProcessGuard',
        message,
        timestamp: new Date().toISOString(),
        ...target.identifiers,
      })}\n`,
      { mode: 0o644 },
    );
    return true;
  } catch {
    return false;
  }
}
