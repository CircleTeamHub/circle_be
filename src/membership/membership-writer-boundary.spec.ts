import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const REPO_ROOT = join(__dirname, '../..');

function filesUnder(root: string): string[] {
  // Paths come only from the repository root and directory entries below it.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (entry === 'generated' || entry === 'node_modules') return [];
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('membership writer boundary', () => {
  it('keeps the retired operational VIP writer inert', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'scripts/set-vip.mjs'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(source).toContain('Direct VIP writes are retired');
    expect(source).not.toContain('PrismaClient');
    expect(source).not.toMatch(/vipLevel\s*:/);
  });

  it('does not seed membership levels outside the audited admin grant path', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'scripts/seed-test-data.js'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(source).not.toMatch(/vipLevel\s*:/);
    expect(source).toContain('admin membership grant API');
  });

  it('has no production Prisma membership write outside MembershipAdminService', () => {
    const productionFiles = filesUnder(join(REPO_ROOT, 'src')).filter(
      (file) =>
        /\.ts$/.test(file) &&
        !/\.spec\.ts$/.test(file) &&
        !file.endsWith('membership-admin.service.ts'),
    );
    const offenders = productionFiles
      .filter((file) => {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        return /data\s*:\s*\{[^{}]*vip(?:Level|ExpiresAt)\s*:/.test(source);
      })
      .map((file) => relative(REPO_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('keeps retired membership entitlements out of production source', () => {
    const retiredEntitlement =
      /created.?circles|premium.?circle|priority.?support/i;
    const offenders = filesUnder(join(REPO_ROOT, 'src'))
      .filter((file) => /\.ts$/.test(file) && !/\.spec\.ts$/.test(file))
      .filter((file) => {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        return retiredEntitlement.test(source);
      })
      .map((file) => relative(REPO_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
