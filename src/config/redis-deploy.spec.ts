import { execFileSync, spawnSync } from 'child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function resolveBashExecutable(): string {
  const configured = process.env.BASH_EXECUTABLE;
  const candidates = [
    ...(configured ? [configured] : []),
    ...(process.platform === 'win32'
      ? [
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        ]
      : []),
    'bash',
  ];

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'true'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }

  throw new Error(
    'A functional Bash is required for redis deployment tests; set BASH_EXECUTABLE to its path.',
  );
}

describe('production Redis deployment configuration', () => {
  const repositoryRoot = join(__dirname, '..', '..');
  const bashExecutable = resolveBashExecutable();
  const workspaces: string[] = [];
  const createWorkspace = (prefix: string) => {
    const workspace = mkdtempSync(join(tmpdir(), prefix));
    workspaces.push(workspace);
    return workspace;
  };

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('generates matching Redis credentials and upgrades existing env files idempotently', () => {
    const workspace = createWorkspace('circle-redis-env-');
    mkdirSync(join(workspace, 'deploy'));
    cpSync(
      join(repositoryRoot, 'deploy', 'gen-env.sh'),
      join(workspace, 'deploy', 'gen-env.sh'),
    );

    const args = [
      'deploy/gen-env.sh',
      '203.0.113.10',
      'api.example.com',
      'admin.example.com',
      'ops@example.com',
    ];
    execFileSync(bashExecutable, args, { cwd: workspace });
    const firstComposeEnv = readFileSync(join(workspace, '.env'), 'utf8');
    const firstAppEnv = readFileSync(
      join(workspace, '.env.production'),
      'utf8',
    );
    const password = firstComposeEnv.match(/^REDIS_PASSWORD=(.+)$/m)?.[1];
    const originalSecret = firstAppEnv.match(/^SECRET=(.+)$/m)?.[1];

    expect(password).toMatch(/^[a-f0-9]{48}$/);
    expect(firstAppEnv).toContain(
      `REDIS_URL="redis://default:${password}@redis:6379"`,
    );
    expect(firstAppEnv).toContain('REDIS_ALLOW_INSECURE=true');
    expect(firstComposeEnv).toContain('API_DOMAIN=api.example.com');
    expect(firstComposeEnv).toContain('ADMIN_DOMAIN=admin.example.com');
    expect(firstComposeEnv).toContain('ACME_EMAIL=ops@example.com');
    if (process.platform !== 'win32') {
      expect(statSync(join(workspace, '.env')).mode & 0o777).toBe(0o600);
      expect(statSync(join(workspace, '.env.production')).mode & 0o777).toBe(
        0o600,
      );
    }

    execFileSync(bashExecutable, args, { cwd: workspace });
    const upgradedComposeEnv = readFileSync(join(workspace, '.env'), 'utf8');
    const upgradedAppEnv = readFileSync(
      join(workspace, '.env.production'),
      'utf8',
    );

    expect(upgradedComposeEnv.match(/^REDIS_PASSWORD=/gm)).toHaveLength(1);
    expect(upgradedAppEnv.match(/^REDIS_URL=/gm)).toHaveLength(1);
    expect(upgradedAppEnv.match(/^REDIS_ALLOW_INSECURE=/gm)).toHaveLength(1);
    expect(upgradedAppEnv).toContain(`SECRET=${originalSecret}`);

    writeFileSync(
      join(workspace, '.env'),
      upgradedComposeEnv.replace(/^COMPOSE_PROFILES=.*\n?/m, ''),
    );
    writeFileSync(
      join(workspace, '.env.production'),
      upgradedAppEnv
        .replace(
          /^REDIS_URL=.*$/m,
          'REDIS_URL="rediss://default:secret@cache.example.com:6380"',
        )
        .replace(/^REDIS_ALLOW_INSECURE=.*\n?/m, ''),
    );
    execFileSync(bashExecutable, args, { cwd: workspace });
    expect(readFileSync(join(workspace, '.env'), 'utf8')).not.toContain(
      'COMPOSE_PROFILES=bundled-redis',
    );
    expect(readFileSync(join(workspace, '.env.production'), 'utf8')).toContain(
      'REDIS_ALLOW_INSECURE=false',
    );
  });

  it('bounds Redis memory and lets application config choose the endpoint', () => {
    const compose = readFileSync(
      join(repositoryRoot, 'docker-compose.prod.yml'),
      'utf8',
    );

    const normalizedCompose = compose.split('\r\n').join('\n');
    const redisService = normalizedCompose
      .split('\n  redis:\n')[1]
      ?.split('\n  minio:')[0];
    expect(redisService).toContain("profiles: ['bundled-redis']");
    expect(redisService).toContain('--appendonly yes');
    expect(redisService).toContain('--maxmemory 512mb');
    expect(redisService).toContain('--maxmemory-policy noeviction');
    expect(redisService).toContain('mem_limit: 768m');
    expect(redisService).toContain('test -n "$$REDIS_PASSWORD"');
    expect(redisService).toContain('redis-cli ping');
    expect(redisService).not.toMatch(/^\s+ports:/m);
    expect(compose).not.toMatch(/^\s+REDIS_URL:/m);
    expect(compose).not.toContain("'9000:9000'");
    expect(compose).not.toContain('mc anonymous set download');
    expect(compose).toContain('target: build-stage');
    expect(compose).not.toContain('npx --yes prisma@');

    const caddy = readFileSync(
      join(repositoryRoot, 'deploy', 'Caddyfile.admin'),
      'utf8',
    );
    expect(caddy).toContain('@metrics path /metrics /metrics/*');
    expect(caddy).toContain('respond 404');
    expect(caddy).toContain('handle /circle/*');
    expect(caddy).toContain('reverse_proxy minio:9000');

    // 限流：Caddy 是收口之后 OpenIM 网关唯一的公网入口。之前这两条 handle 是裸
    // reverse_proxy，不限速也不限连接数 —— 一个脚本就能直接压网关。
    expect(caddy).toContain('order rate_limit before reverse_proxy');
    for (const zone of ['openim_ws', 'openim_api', 'api_fallback']) {
      expect(caddy).toContain(`zone ${zone} {`);
    }

    // rate_limit 不在官方 caddy 镜像里，必须用带该模块的自定义构建；
    // 镜像换回 caddy:2-alpine 会让上面的指令直接把 Caddy 启动打挂。
    const caddyDockerfile = readFileSync(
      join(repositoryRoot, 'Dockerfile.caddy'),
      'utf8',
    );
    expect(caddyDockerfile).toContain('caddy-ratelimit');
    expect(compose).toContain('dockerfile: Dockerfile.caddy');
    expect(compose).not.toMatch(/^\s+image: caddy:2-alpine\s*$/m);
  });

  it('openim-harden.sh can collapse the gateway ports behind Caddy', () => {
    const harden = readFileSync(
      join(repositoryRoot, 'deploy', 'openim-harden.sh'),
      'utf8',
    );

    // 10001/10002 默认对外（测试期直连），但必须存在一条把它们收进内网的路径 ——
    // 在收口之前，Caddyfile 里的限流全部被绕过，等于不存在。
    expect(harden).toContain('--collapse-public-ports');
    // 收口模式下放行清单只保留 metrics，否则 pin_variable_ports 仍会跳过网关端口。
    expect(harden).toMatch(
      /COLLAPSE_PUBLIC_PORTS.*=.*1.*\]\s*&&\s*allow_internal=/,
    );

    // ⚠️ 收口绝不能绑 127.0.0.1：Caddy 跑在容器里、经 host.docker.internal 回连宿主机，
    // 绑回环等于连 Caddy 都到不了 —— 收口即全站 IM 中断（502），而 ss 看着一切正常。
    // 必须绑 docker bridge 网关（对容器可达、对公网不可达）。
    expect(harden).toContain('OPENIM_GATEWAY_BIND_IP');
    expect(harden).toMatch(/docker network inspect bridge/);
    expect(harden).not.toMatch(/HOST_BIND_IP=127\.0\.0\.1/);

    // Kafka 的容器上限必须配套压堆，否则洪泛时 JVM 撑爆被 OOM kill 成崩溃循环。
    expect(harden).toContain('KAFKA_HEAP_OPTS');

    // 消息大小上限：服务端唯一能安全强制的地方。before-send 回调是 fail-CLOSED
    // （OpenIM 从不读 failedContinue，2026-08 复核仍如此），circle_be 一挂就阻塞
    // 全体消息；websocketMaxMsgLen 在网关本地判定，没有这个风险。
    expect(harden).toContain('websocketMaxMsgLen');
    expect(harden).toContain('OPENIM_MAX_MSG_LEN');
    // glob 不匹配时必须 `|| true`：脚本开着 set -euo pipefail，否则配置目录布局
    // 一变就从这里静默中止，而此前的改动已经落盘、只做了一半。
    expect(harden).toMatch(/openim-msggateway\.y\*ml[\s\S]{0,80}?\|\| true/);
    // metrics 端口要常驻放行，否则重跑加固会把它钉掉，洪泛重新变成不可见。
    expect(harden).toContain('OPENIM_METRICS_PORTS');
  });

  it('regenerates an empty password and merges the bundled profile on upgrade', () => {
    const workspace = createWorkspace('circle-redis-upgrade-');
    mkdirSync(join(workspace, 'deploy'));
    cpSync(
      join(repositoryRoot, 'deploy', 'gen-env.sh'),
      join(workspace, 'deploy', 'gen-env.sh'),
    );
    writeFileSync(
      join(workspace, '.env'),
      [
        'DB_PASSWORD=db',
        'MINIO_ROOT_USER=minio',
        'MINIO_ROOT_PASSWORD=minio-secret',
        'API_DOMAIN=',
        'ADMIN_DOMAIN=',
        'ACME_EMAIL=',
        'REDIS_PASSWORD=bad#password',
        'COMPOSE_PROFILES=debug-tools',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(workspace, '.env.production'),
      'NODE_ENV=production\nREDIS_URL="redis://default:@redis:6379"\n',
    );

    execFileSync(
      bashExecutable,
      [
        'deploy/gen-env.sh',
        '203.0.113.10',
        'api.example.com',
        'admin.example.com',
        'ops@example.com',
      ],
      { cwd: workspace },
    );

    const composeEnv = readFileSync(join(workspace, '.env'), 'utf8');
    const appEnv = readFileSync(join(workspace, '.env.production'), 'utf8');
    const password = composeEnv.match(/^REDIS_PASSWORD=(.+)$/m)?.[1];
    expect(password).toMatch(/^[a-f0-9]{48}$/);
    expect(composeEnv).toContain('COMPOSE_PROFILES=debug-tools,bundled-redis');
    expect(composeEnv).toContain('API_DOMAIN=api.example.com');
    expect(composeEnv).toContain('ADMIN_DOMAIN=admin.example.com');
    expect(composeEnv).toContain('ACME_EMAIL=ops@example.com');
    expect(appEnv).toContain(
      `REDIS_URL="redis://default:${password}@redis:6379"`,
    );
  });

  it('rejects upgrading when the compose env file is missing', () => {
    const workspace = createWorkspace('circle-redis-invalid-');
    mkdirSync(join(workspace, 'deploy'));
    cpSync(
      join(repositoryRoot, 'deploy', 'gen-env.sh'),
      join(workspace, 'deploy', 'gen-env.sh'),
    );
    writeFileSync(join(workspace, '.env.production'), 'NODE_ENV=production\n');

    expect(() =>
      execFileSync(
        bashExecutable,
        [
          'deploy/gen-env.sh',
          '203.0.113.10',
          'api.example.com',
          'admin.example.com',
          'ops@example.com',
        ],
        { cwd: workspace, stdio: 'pipe' },
      ),
    ).toThrow();
  });
});
