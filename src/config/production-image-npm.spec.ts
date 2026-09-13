import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('production image npm toolchain', () => {
  it('runs the bundled Prisma CLI directly and removes npm from the runtime image', () => {
    const dockerfile = readFileSync(
      join(process.cwd(), 'Dockerfile.prod'),
      'utf8',
    );
    const compose = readFileSync(
      join(process.cwd(), 'docker-compose.prod.yml'),
      'utf8',
    );
    const [buildStage, productionStage] = dockerfile.split(
      '# --- production stage',
    );

    expect(buildStage).toContain('npm install -g npm@12.0.2');
    expect(productionStage).toContain(
      'apt-get install -y --no-install-recommends openssl',
    );
    // Debian 的安全修复总是先于 node:22-slim 重建发布，而阻断式 Trivy 扫描开着
    // ignore-unfixed：上游一出修复、基础镜像还没跟上，CI 就红。构建时必须打上
    // 待装的安全更新，和 Dockerfile.caddy 的 `apk upgrade --no-cache` 同一个道理。
    expect(productionStage).toMatch(/apt-get upgrade -y/);
    expect(productionStage).toContain('install -d -o app -g app /app/logs');
    expect(productionStage).toContain('rm -rf /usr/local/lib/node_modules/npm');
    expect(productionStage).not.toContain('npm install -g npm@12.0.2');
    expect(compose).toContain(
      'command: ./node_modules/.bin/prisma migrate deploy',
    );
    expect(compose).not.toContain('command: npx prisma migrate deploy');
    expect(dockerfile).not.toContain('npm@latest');
  });
});
