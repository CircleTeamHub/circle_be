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

  it('generates matching Redis credentials and rejects legacy reruns without mutation', () => {
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
      'app.example.com',
    ];
    execFileSync(bashExecutable, args, { cwd: workspace });
    const firstComposeEnv = readFileSync(join(workspace, '.env'), 'utf8');
    const firstAppEnv = readFileSync(
      join(workspace, '.env.production'),
      'utf8',
    );
    const password = firstComposeEnv.match(/^REDIS_PASSWORD=(.+)$/m)?.[1];
    const originalSecret = firstAppEnv.match(/^SECRET=(.+)$/m)?.[1];
    const primaryGid =
      process.platform === 'win32'
        ? undefined
        : Number(
            execFileSync('/usr/bin/id', [
              '-g',
              execFileSync('/usr/bin/id', ['-un']).toString().trim(),
            ])
              .toString()
              .trim(),
          );

    expect(password).toMatch(/^[a-f0-9]{48}$/);
    expect(firstAppEnv).toContain(
      `REDIS_URL="redis://default:${password}@redis:6379"`,
    );
    expect(firstAppEnv).toContain('REDIS_ALLOW_INSECURE=true');
    expect(firstComposeEnv).toContain('API_DOMAIN=api.example.com');
    expect(firstComposeEnv).toContain('ADMIN_DOMAIN=admin.example.com');
    expect(firstComposeEnv).toContain('ACME_EMAIL=ops@example.com');
    expect(firstComposeEnv).toContain('WEB_DOMAIN=app.example.com');
    expect(firstAppEnv).toContain(
      'ALLOWED_ORIGINS=https://admin.example.com,https://app.example.com',
    );
    if (process.platform !== 'win32') {
      expect(firstComposeEnv).toContain(`APP_ENV_GID=${primaryGid}`);
      expect(statSync(join(workspace, '.env')).mode & 0o777).toBe(0o600);
      expect(statSync(join(workspace, '.env.production')).mode & 0o777).toBe(
        0o640,
      );
      expect(statSync(join(workspace, '.env.production')).gid).toBe(primaryGid);
    }

    execFileSync(bashExecutable, args, { cwd: workspace });
    const upgradedComposeEnv = readFileSync(join(workspace, '.env'), 'utf8');
    const upgradedAppEnv = readFileSync(
      join(workspace, '.env.production'),
      'utf8',
    );

    expect(upgradedComposeEnv.match(/^REDIS_PASSWORD=/gm)).toHaveLength(1);
    expect(upgradedComposeEnv.match(/^APP_ENV_GID=/gm)).toHaveLength(1);
    expect(upgradedAppEnv.match(/^REDIS_URL=/gm)).toHaveLength(1);
    expect(upgradedAppEnv.match(/^REDIS_ALLOW_INSECURE=/gm)).toHaveLength(1);
    expect(upgradedAppEnv).toContain(`SECRET=${originalSecret}`);

    writeFileSync(
      join(workspace, '.env'),
      upgradedComposeEnv
        .replace(/^COMPOSE_PROFILES=.*\n?/m, '')
        .replace(/^APP_ENV_GID=.*$/m, 'APP_ENV_GID=999999'),
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
    const regeneratedComposeEnv = readFileSync(join(workspace, '.env'), 'utf8');
    expect(regeneratedComposeEnv).not.toContain(
      'COMPOSE_PROFILES=bundled-redis',
    );
    if (process.platform !== 'win32') {
      expect(regeneratedComposeEnv).toContain(`APP_ENV_GID=${primaryGid}`);
    }
    expect(readFileSync(join(workspace, '.env.production'), 'utf8')).toContain(
      'REDIS_ALLOW_INSECURE=false',
    );
  });

  it('clears inherited default ACLs before writing fresh secrets', () => {
    if (process.platform !== 'linux') return;
    for (const command of ['setfacl', 'getfacl']) {
      if (spawnSync(command, ['--version'], { stdio: 'ignore' }).status !== 0)
        return;
    }
    if (
      spawnSync('getent', ['passwd', 'nobody'], { stdio: 'ignore' }).status !==
      0
    )
      return;

    const workspace = createWorkspace('circle-default-acl-env-');
    mkdirSync(join(workspace, 'deploy'));
    cpSync(
      join(repositoryRoot, 'deploy', 'gen-env.sh'),
      join(workspace, 'deploy', 'gen-env.sh'),
    );
    execFileSync('setfacl', ['-m', 'u:nobody:r-x,d:u:nobody:r-x', workspace]);

    const bin = join(workspace, 'bin');
    mkdirSync(bin);
    const catProbe = join(bin, 'cat');
    writeFileSync(
      catProbe,
      `#!/usr/bin/env bash
set -euo pipefail
for file in .env.tmp .env.production.tmp; do
  if [ -e "$file" ] && getfacl -cp "$file" | grep -q '^user:nobody:'; then
    echo "named ACL was still active before secrets were written to $file" >&2
    exit 91
  fi
done
exec "$REAL_CAT" "$@"
`,
      { mode: 0o755 },
    );
    const realCat = execFileSync('/bin/sh', ['-c', 'command -v cat'])
      .toString()
      .trim();
    execFileSync(
      bashExecutable,
      [
        'deploy/gen-env.sh',
        '203.0.113.10',
        'api.example.com',
        'admin.example.com',
        'ops@example.com',
        'app.example.com',
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          REAL_CAT: realCat,
        },
      },
    );

    const acl = execFileSync('getfacl', [
      '-cp',
      join(workspace, '.env.production'),
    ]).toString();
    expect(acl).not.toMatch(/^user:nobody:/m);
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

    // 限流：Caddy 是公网唯一入口，每条 handle 都必须有自己的桶，否则一个脚本
    // 就能直接压上游。openim_ws / openim_api 两个 zone 随 OpenIM 出清一并删除。
    expect(caddy).toContain('order rate_limit before reverse_proxy');
    for (const zone of [
      'minio_media',
      'api_fallback',
      'admin_api',
      'admin_web',
    ]) {
      expect(caddy).toContain(`zone ${zone} {`);
    }
    // 回潮防线：OpenIM 已出清，这两条 handle 不该再出现。
    expect(caddy).not.toContain('openim');

    // rate_limit 不在官方 caddy 镜像里，必须用带该模块的自定义构建；
    // 镜像换回 caddy:2-alpine 会让上面的指令直接把 Caddy 启动打挂。
    const caddyDockerfile = readFileSync(
      join(repositoryRoot, 'Dockerfile.caddy'),
      'utf8',
    );
    expect(caddyDockerfile).toContain('caddy-ratelimit');
    expect(caddyDockerfile).toContain(
      '--replace golang.org/x/net=golang.org/x/net@v0.56.0',
    );
    expect(caddyDockerfile).toContain(
      '--replace golang.org/x/text=golang.org/x/text@v0.39.0',
    );
    expect(caddyDockerfile).toContain(
      '--replace google.golang.org/grpc=google.golang.org/grpc@v1.82.1',
    );
    expect(caddyDockerfile).toContain('RUN apk upgrade --no-cache');
    expect(compose).toContain('dockerfile: Dockerfile.caddy');
    expect(compose).not.toMatch(/^\s+image: caddy:2-alpine\s*$/m);
  });

  it('rejects legacy upgrades before changing either env file', () => {
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
        'WEB_DOMAIN=',
        'REDIS_PASSWORD=bad#password',
        'COMPOSE_PROFILES=debug-tools',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(workspace, '.env.production'),
      [
        'NODE_ENV=production',
        'REDIS_URL="redis://default:@redis:6379"',
        'ALLOWED_ORIGINS="https://legacy.example.com"',
        '',
      ].join('\n'),
    );

    const originalComposeEnv = readFileSync(join(workspace, '.env'), 'utf8');
    const originalAppEnv = readFileSync(
      join(workspace, '.env.production'),
      'utf8',
    );
    const result = spawnSync(
      bashExecutable,
      [
        'deploy/gen-env.sh',
        '203.0.113.10',
        'api.example.com',
        'admin.example.com',
        'ops@example.com',
        'app.example.com',
      ],
      { cwd: workspace, encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('拒绝原地重写');
    expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe(
      originalComposeEnv,
    );
    expect(readFileSync(join(workspace, '.env.production'), 'utf8')).toBe(
      originalAppEnv,
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
          'app.example.com',
        ],
        { cwd: workspace, stdio: 'pipe' },
      ),
    ).toThrow();
  });

  it('requires the user web domain so fresh deployments cannot omit CORS', () => {
    const workspace = createWorkspace('circle-web-origin-required-');
    mkdirSync(join(workspace, 'deploy'));
    cpSync(
      join(repositoryRoot, 'deploy', 'gen-env.sh'),
      join(workspace, 'deploy', 'gen-env.sh'),
    );

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
