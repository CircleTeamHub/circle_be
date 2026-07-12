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
