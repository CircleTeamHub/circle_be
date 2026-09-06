import { isEmail } from 'class-validator';
import { normalizeEmail } from 'src/utils/email';

/**
 * 固定验证码旁路的唯一判定来源。
 *
 * 之前这套规则只活在 EmailVerificationService 的两个私有方法里：env 校验看不见它，
 * 启动日志和 /metrics 也看不见它，于是「生产环境的旁路一直开着」没有任何信号 ——
 * 探针全绿、没人被叫醒。判定、校验、上报共用这里的同一份实现。
 */

/** production 下允许旁路的用途。RESET_PASSWORD 永远不在内。 */
export const BYPASSABLE_PURPOSES = ['REGISTER', 'LOGIN'] as const;

/**
 * production 下固定码的最小长度。
 *
 * 6 位数字（示例里写的就是 999999）一次就能猜中：旁路分支在 MAX_ATTEMPTS 锁定
 * 之前判定，所以攻击者不会被计入失败锁定，唯一的阻力是每 IP 10 次/15 分钟的限流。
 * 允许名单把影响面收敛到具体账号，但被列进去的账号仍等同于免密登录，
 * 因此 production 只接受足够长的随机码。
 */
export const PRODUCTION_BYPASS_CODE_MIN_LENGTH = 16;

export interface EmailCodeBypassEnv {
  NODE_ENV?: string;
  EMAIL_CODE_DEV_BYPASS?: string;
  EMAIL_CODE_ALLOW_PRODUCTION_BYPASS?: string | boolean;
  EMAIL_CODE_PRODUCTION_BYPASS_ALLOWLIST?: string;
  /** jest 在每个 worker（含 --runInBand）都会设它；线上进程永远没有。 */
  JEST_WORKER_ID?: string;
}

/**
 * 无限制旁路只认两种进程：本机 development，以及跑在 jest 里的测试进程。
 *
 * 「不是 production 就放开」是 fail-open 的判法：NODE_ENV 没设的时候它同样成立，
 * 而没设恰恰是共享机器上最常见的情况 —— 裸跑一次 `node dist/main.js`，或者一个
 * 一次性的冒烟脚本，都不会带上 NODE_ENV。env.validation 只放行
 * development|production|test，所以「写错成 staging」会启动失败；但「压根没设」
 * 一路绿灯，而且 Joi 的 .default('development') 落在 ConfigService 对象上，不会
 * 写回 process.env，这里读的正是 process.env。
 *
 * NODE_ENV=test 单独也不够：它是 env.validation 允许的三个值之一，部署时同样
 * 可能被选中。再要求 JEST_WORKER_ID 才算数 —— e2e 把 Nest 应用起在 jest 进程内
 * （test/app.factory.ts 用 Test.createTestingModule + app.listen(0)），所以 CI 的
 * E2E 任务照常能用固定码注册；而一台服务器无论如何都拿不到这个变量。
 */
function isUnrestrictedBypassEnv(env: EmailCodeBypassEnv): boolean {
  if (env.NODE_ENV === 'development') return true;
  return env.NODE_ENV === 'test' && Boolean(env.JEST_WORKER_ID);
}

export type EmailCodeBypassStatus =
  /** 未配置固定码，或受限环境缺少显式开关 —— 没有旁路。 */
  | 'off'
  /** development 或 jest 进程：固定码对所有用途有效（含 RESET_PASSWORD）。 */
  | 'non-production'
  /** production：固定码对允许名单里的 (purpose, email) 生效。 */
  | 'active'
  /** production 显式开了旁路，但配置不合格，因此 fail closed 关掉。 */
  | 'misconfigured';

export interface EmailCodeBypassState {
  status: EmailCodeBypassStatus;
  /** 允许名单条目数。只在 active 时有意义，且永不包含邮箱本身。 */
  identities: number;
  /** misconfigured 的原因。只说哪一项不合格，不回显取值。 */
  reason?: string;
}

/**
 * `PURPOSE:email` 列表。任何一条不合格都整份作废（fail closed）—— 半份生效的
 * 允许名单比没有更危险。
 */
export function parseEmailBypassAllowlist(
  raw: string | null | undefined,
): Set<string> | null {
  if (!raw?.trim()) return null;

  const allowed = new Set<string>();
  for (const rawEntry of raw.split(',')) {
    const parts = rawEntry.split(':');
    if (parts.length !== 2) return null;
    const purpose = parts[0].trim().toUpperCase();
    const email = normalizeEmail(parts[1]);
    if (
      !(BYPASSABLE_PURPOSES as readonly string[]).includes(purpose) ||
      !isEmail(email)
    ) {
      return null;
    }
    allowed.add(`${purpose}:${email}`);
  }
  return allowed;
}

function trimmedBypassCode(env: EmailCodeBypassEnv): string | null {
  const value = env.EMAIL_CODE_DEV_BYPASS?.trim();
  if (!value || value.toLowerCase() === 'off') return null;
  return value;
}

function productionOptInEnabled(env: EmailCodeBypassEnv): boolean {
  return String(env.EMAIL_CODE_ALLOW_PRODUCTION_BYPASS) === 'true';
}

/**
 * 旁路当前处于什么状态 —— 启动横幅、/metrics 和 env 校验共用。
 * 不接受 email/purpose，因此永远不会把允许名单里的地址带进日志或指标。
 */
export function describeEmailCodeBypass(
  env: EmailCodeBypassEnv = process.env,
): EmailCodeBypassState {
  const code = trimmedBypassCode(env);
  if (!code) return { status: 'off', identities: 0 };
  if (isUnrestrictedBypassEnv(env)) {
    return { status: 'non-production', identities: 0 };
  }
  if (!productionOptInEnabled(env)) return { status: 'off', identities: 0 };
  if (code.length < PRODUCTION_BYPASS_CODE_MIN_LENGTH) {
    return {
      status: 'misconfigured',
      identities: 0,
      reason: `EMAIL_CODE_DEV_BYPASS must be at least ${PRODUCTION_BYPASS_CODE_MIN_LENGTH} characters when EMAIL_CODE_ALLOW_PRODUCTION_BYPASS is true`,
    };
  }
  const allowed = parseEmailBypassAllowlist(
    env.EMAIL_CODE_PRODUCTION_BYPASS_ALLOWLIST,
  );
  if (!allowed) {
    return {
      status: 'misconfigured',
      identities: 0,
      reason:
        'EMAIL_CODE_PRODUCTION_BYPASS_ALLOWLIST must list one or more PURPOSE:email entries, where PURPOSE is REGISTER or LOGIN',
    };
  }
  return { status: 'active', identities: allowed.size };
}

/**
 * 这次 (email, purpose) 能不能用固定码通过。返回码本身，便于调用方做等值比较。
 */
export function resolveEmailBypassCode(
  email: string,
  purpose: string,
  env: EmailCodeBypassEnv = process.env,
): string | null {
  const code = trimmedBypassCode(env);
  if (!code) return null;
  if (isUnrestrictedBypassEnv(env)) return code;
  if (!(BYPASSABLE_PURPOSES as readonly string[]).includes(purpose))
    return null;
  if (!productionOptInEnabled(env)) return null;
  if (code.length < PRODUCTION_BYPASS_CODE_MIN_LENGTH) return null;
  const allowed = parseEmailBypassAllowlist(
    env.EMAIL_CODE_PRODUCTION_BYPASS_ALLOWLIST,
  );
  if (!allowed?.has(`${purpose}:${email}`)) return null;
  return code;
}
