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
    expect(productionStage).toContain('rm -rf /usr/local/lib/node_modules/npm');
    expect(productionStage).not.toContain('npm install -g npm@12.0.2');
    expect(compose).toContain(
      'command: ./node_modules/.bin/prisma migrate deploy',
    );
    expect(compose).not.toContain('command: npx prisma migrate deploy');
    expect(dockerfile).not.toContain('npm@latest');
  });
});
