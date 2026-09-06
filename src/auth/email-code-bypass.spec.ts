import {
  PRODUCTION_BYPASS_CODE_MIN_LENGTH,
  describeEmailCodeBypass,
  parseEmailBypassAllowlist,
  resolveEmailBypassCode,
} from './email-code-bypass';

const STRONG_CODE = 'Zq7mK2xR9vT4sPwL8bN3';

const productionEnv = {
  NODE_ENV: 'production',
  EMAIL_CODE_DEV_BYPASS: STRONG_CODE,
  EMAIL_CODE_ALLOW_PRODUCTION_BYPASS: 'true',
  EMAIL_CODE_PRODUCTION_BYPASS_ALLOWLIST: 'LOGIN:allowed@example.com',
};

describe('parseEmailBypassAllowlist', () => {
  it('normalizes purpose casing and email whitespace', () => {
    expect(
      parseEmailBypassAllowlist(' register : Allowed@Example.com '),
    ).toEqual(new Set(['REGISTER:allowed@example.com']));
  });

  it.each([
    undefined,
    '',
    '   ',
    'malformed,LOGIN:allowed@example.com',
    'LOGIN:',
    ':allowed@example.com',
    'LOGIN:allowed@example.com:extra',
    'UNKNOWN:allowed@example.com',
    'RESET_PASSWORD:allowed@example.com',
    'LOGIN:not-an-email',
    'LOGIN:allowed@example.com,',
  ])('fails the whole list closed for %s', (raw) => {
    expect(parseEmailBypassAllowlist(raw)).toBeNull();
  });
});

describe('describeEmailCodeBypass', () => {
  it('reports off when no fixed code is configured', () => {
    expect(describeEmailCodeBypass({ NODE_ENV: 'production' })).toEqual({
      status: 'off',
      identities: 0,
    });
    expect(
      describeEmailCodeBypass({
        NODE_ENV: 'production',
        EMAIL_CODE_DEV_BYPASS: 'off',
      }),
    ).toEqual({ status: 'off', identities: 0 });
  });

  it('reports non-production without leaking the allowlist size', () => {
    expect(
      describeEmailCodeBypass({
        NODE_ENV: 'development',
        EMAIL_CODE_DEV_BYPASS: '999999',
      }),
    ).toEqual({ status: 'non-production', identities: 0 });
  });

  it('reports off in production without the second opt-in', () => {
    expect(
      describeEmailCodeBypass({
        ...productionEnv,
        EMAIL_CODE_ALLOW_PRODUCTION_BYPASS: undefined,
      }),
    ).toEqual({ status: 'off', identities: 0 });
  });

  it('counts allowlisted identities when the production bypass is live', () => {
    expect(
      describeEmailCodeBypass({
        ...productionEnv,
        EMAIL_CODE_PRODUCTION_BYPASS_ALLOWLIST:
          'LOGIN:allowed@example.com,REGISTER:allowed@example.com',
      }),
    ).toEqual({ status: 'active', identities: 2 });
  });

  it('reports misconfigured for a code that is too short to survive guessing', () => {
    const state = describeEmailCodeBypass({
      ...productionEnv,
      EMAIL_CODE_DEV_BYPASS: '999999',
    });

    expect(state.status).toBe('misconfigured');
    expect(state.reason).toContain(String(PRODUCTION_BYPASS_CODE_MIN_LENGTH));
  });

  it('reports misconfigured for a missing or malformed allowlist', () => {
    for (const allowlist of [undefined, 'LOGIN:not-an-email']) {
      const state = describeEmailCodeBypass({
        ...productionEnv,
        EMAIL_CODE_PRODUCTION_BYPASS_ALLOWLIST: allowlist,
      });

      expect(state.status).toBe('misconfigured');
      expect(state.reason).toContain('EMAIL_CODE_PRODUCTION_BYPASS_ALLOWLIST');
    }
  });
});

describe('resolveEmailBypassCode', () => {
  it('bypasses every purpose in development', () => {
    const env = { NODE_ENV: 'development', EMAIL_CODE_DEV_BYPASS: '999999' };

    for (const purpose of ['REGISTER', 'LOGIN', 'RESET_PASSWORD']) {
      expect(resolveEmailBypassCode('anyone@example.com', purpose, env)).toBe(
        '999999',
      );
    }
  });

  it('bypasses every purpose in a jest process, which is how the e2e suite registers', () => {
    // e2e 把 Nest 应用起在 jest 进程里，CI 的 E2E 任务就靠固定码注册。
    const env = {
      NODE_ENV: 'test',
      JEST_WORKER_ID: '1',
      EMAIL_CODE_DEV_BYPASS: '999999',
    };

    for (const purpose of ['REGISTER', 'LOGIN', 'RESET_PASSWORD']) {
      expect(resolveEmailBypassCode('anyone@example.com', purpose, env)).toBe(
        '999999',
      );
    }
  });

  // 这一组就是 issue #103 问的场景：共享机器上留下了 EMAIL_CODE_DEV_BYPASS，
  // 而 NODE_ENV 没设、或者被设成了 development 以外的值。没有 JEST_WORKER_ID，
  // 就说明这不是测试进程，必须走 production 那套开关加允许名单。
  it.each([
    ['NODE_ENV unset', {}],
    ['NODE_ENV=test without a jest process', { NODE_ENV: 'test' }],
    ['an unexpected NODE_ENV', { NODE_ENV: 'preprod' }],
  ])('refuses the weak code with %s', (_label, envOverrides) => {
    const env = { ...envOverrides, EMAIL_CODE_DEV_BYPASS: '999999' };

    for (const purpose of ['REGISTER', 'LOGIN', 'RESET_PASSWORD']) {
      expect(
        resolveEmailBypassCode('anyone@example.com', purpose, env),
      ).toBeNull();
    }
  });

  it('still honours the opt-in and allowlist when NODE_ENV is unset', () => {
    // 反转默认没有拿走那条受控逃生口，只是不再默认敞开：配齐开关、够长的码和
    // 允许名单之后，未标注环境的主机与 production 走同一套规则。
    const env = {
      EMAIL_CODE_DEV_BYPASS: STRONG_CODE,
      EMAIL_CODE_ALLOW_PRODUCTION_BYPASS: 'true',
      EMAIL_CODE_PRODUCTION_BYPASS_ALLOWLIST: 'LOGIN:allowed@example.com',
    };

    expect(resolveEmailBypassCode('allowed@example.com', 'LOGIN', env)).toBe(
      STRONG_CODE,
    );
    expect(
      resolveEmailBypassCode('other@example.com', 'LOGIN', env),
    ).toBeNull();
    expect(
      resolveEmailBypassCode('allowed@example.com', 'RESET_PASSWORD', env),
    ).toBeNull();
  });

  it('matches only the exact normalized identity in production', () => {
    expect(
      resolveEmailBypassCode('allowed@example.com', 'LOGIN', productionEnv),
    ).toBe(STRONG_CODE);
    expect(
      resolveEmailBypassCode('other@example.com', 'LOGIN', productionEnv),
    ).toBeNull();
    expect(
      resolveEmailBypassCode('allowed@example.com', 'REGISTER', productionEnv),
    ).toBeNull();
  });

  it('never bypasses password reset in production', () => {
    expect(
      resolveEmailBypassCode('allowed@example.com', 'RESET_PASSWORD', {
        ...productionEnv,
        EMAIL_CODE_PRODUCTION_BYPASS_ALLOWLIST:
          'RESET_PASSWORD:allowed@example.com',
      }),
    ).toBeNull();
  });

  it('fails closed in production when the code is guessable', () => {
    expect(
      resolveEmailBypassCode('allowed@example.com', 'LOGIN', {
        ...productionEnv,
        EMAIL_CODE_DEV_BYPASS: '999999',
      }),
    ).toBeNull();
  });
});
