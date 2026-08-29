import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('production image npm toolchain', () => {
  it('pins the patched npm CLI in both the migrate and runtime stages', () => {
    const dockerfile = readFileSync(
      join(process.cwd(), 'Dockerfile.prod'),
      'utf8',
    );
    const [buildStage, productionStage] = dockerfile.split(
      '# --- production stage',
    );

    expect(buildStage).toContain('npm install -g npm@12.0.2');
    expect(productionStage).toContain('npm install -g npm@12.0.2');

    const npmInstall = productionStage.indexOf('npm install -g npm@12.0.2');
    const patchedTarInstall = productionStage.indexOf(
      'npm install -g tar@7.5.21',
    );
    const bundledTarRemoval = productionStage.indexOf(
      'rm -rf "$(npm root -g)/npm/node_modules/tar"',
    );

    expect(patchedTarInstall).toBeGreaterThan(npmInstall);
    expect(bundledTarRemoval).toBeGreaterThan(patchedTarInstall);

    expect(dockerfile).not.toContain('npm@latest');
  });
});
