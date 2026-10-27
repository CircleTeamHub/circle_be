import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureFatalLogFile,
  fatalLogFilePath,
  writeFatalLogLine,
} from './fatal-log-file';

describe('fatal log file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fatal-log-'));
  });

  afterEach(() => {
    configureFatalLogFile(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op until file logging configures a target', () => {
    configureFatalLogFile(null);
    expect(fatalLogFilePath()).toBeNull();
    expect(writeFatalLogLine('[fatal] boom')).toBe(false);
  });

  it('synchronously appends one JSON line in the same shape as the Winston files', () => {
    const path = join(dir, 'logs', 'application-fatal.log');
    configureFatalLogFile(path, {
      serviceName: 'circle-be',
      release: 'circle@1',
      environment: 'production',
    });

    expect(
      writeFatalLogLine(
        '[fatal] Uncaught exception; errorName=Error; exiting.',
      ),
    ).toBe(true);
    expect(writeFatalLogLine('[fatal] second\nline')).toBe(true);

    // 同步写：函数返回时内容已经在文件里，紧接着的 process.exit 截不掉它。
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      level: 'error',
      context: 'ProcessGuard',
      message: '[fatal] Uncaught exception; errorName=Error; exiting.',
      serviceName: 'circle-be',
      release: 'circle@1',
      environment: 'production',
    });
    expect(new Date(first.timestamp).toISOString()).toBe(first.timestamp);
    // 换行被 JSON 转义，一条记录始终只占一行（Alloy 按行切）。
    expect(JSON.parse(lines[1]).message).toBe('[fatal] second\nline');
    // 采集器（Alloy 以另一个 uid 运行）要读得到。
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it('reports failure instead of throwing when the target cannot be written', () => {
    // 普通文件占住目录名，之后 mkdir/append 必然失败。
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, '');
    configureFatalLogFile(join(blocker, 'application-fatal.log'));

    expect(() => writeFatalLogLine('[fatal] boom')).not.toThrow();
    expect(writeFatalLogLine('[fatal] boom')).toBe(false);
  });
});
