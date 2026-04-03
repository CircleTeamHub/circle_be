import { readFileSync } from 'fs';
import { join } from 'path';

describe('package scripts', () => {
  it('runs Prisma generate after install', () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    );

    expect(packageJson.scripts.postinstall).toContain('prisma generate');
  });
});
