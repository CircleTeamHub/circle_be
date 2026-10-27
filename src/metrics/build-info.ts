import { Gauge, Registry } from 'prom-client';

export interface BuildInfoMetrics {
  readonly registry: Registry;
}

export interface BuildIdentity {
  /** 发版脚本写进 env 文件的 SENTRY_RELEASE，形如 `circle-be@v1.2.3`。 */
  release?: unknown;
  /** 构建镜像时烤进去的 CIRCLE_BUILD_COMMIT（build-image.yml 传 github.sha）。 */
  commit?: unknown;
}

export const UNKNOWN_BUILD_VALUE = 'unknown';

const RELEASE_PREFIX = 'circle-be@';
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
const COMMIT_LABEL_LENGTH = 12;

/** `circle-be@v1.2.3` → `v1.2.3`；空值或不像版本号的值一律记成 unknown。 */
export function versionLabel(release: unknown): string {
  if (typeof release !== 'string') return UNKNOWN_BUILD_VALUE;
  const trimmed = release.trim();
  const version = trimmed.startsWith(RELEASE_PREFIX)
    ? trimmed.slice(RELEASE_PREFIX.length)
    : trimmed;
  return VERSION_PATTERN.test(version) ? version : UNKNOWN_BUILD_VALUE;
}

/** 完整 SHA 截成 12 位：足够唯一，标签也短。 */
export function commitLabel(commit: unknown): string {
  if (typeof commit !== 'string') return UNKNOWN_BUILD_VALUE;
  const normalized = commit.trim().toLowerCase();
  return COMMIT_PATTERN.test(normalized)
    ? normalized.slice(0, COMMIT_LABEL_LENGTH)
    : UNKNOWN_BUILD_VALUE;
}

/**
 * 当前进程跑的是哪个版本。恒为 1 的 info 指标，信息全在标签里：
 * - 大盘用它画发版标记：5xx、延迟从哪一刻开始变的，一眼对上是不是某次发版；
 * - BackendVersionSkew 用它发现蓝绿两色长时间跑着不同版本（切换卡在半路）。
 *
 * version 来自 release-deploy.sh 每次发版写进 env 文件的 SENTRY_RELEASE；commit
 * 来自镜像构建时烤进去的环境变量，手动部署、没走发版脚本的机器也有。两者
 * 都只接受固定格式，任何别的值记成 unknown —— 标签值不能由运行时数据决定。
 */
export function createBuildInfoMetrics(
  identity: BuildIdentity,
): BuildInfoMetrics {
  const registry = new Registry();
  const buildInfo = new Gauge({
    name: 'circle_build_info',
    help: 'Running build of circle_be (always 1): release version and commit.',
    labelNames: ['version', 'commit'],
    registers: [registry],
  });
  buildInfo.set(
    {
      version: versionLabel(identity.release),
      commit: commitLabel(identity.commit),
    },
    1,
  );
  return { registry };
}
