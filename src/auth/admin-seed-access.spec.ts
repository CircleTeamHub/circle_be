import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('admin seed console access', () => {
  it('creates the seeded admin and SUPER_ADMIN access atomically', () => {
    const source = readFileSync(
      resolve(__dirname, '../../scripts/seed-admin-user.js'),
      'utf8',
    );

    expect(source).toContain('prisma.$transaction');
    expect(source).toContain('tx.user.upsert');
    expect(source).toContain('tx.adminAccess.upsert');
    expect(source).toMatch(/role:\s*'SUPER_ADMIN'/);
  });
});
