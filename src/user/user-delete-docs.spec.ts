import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('user deletion API guide', () => {
  it('documents admin deletion through the audited admin status endpoint', () => {
    const guide = readFileSync(
      join(process.cwd(), 'docs/frontend-api-guide.md'),
      'utf8',
    );

    expect(guide).toContain('DELETE /user/:id');
    expect(guide).toContain('只能删除自己');
    expect(guide).not.toContain('只能删除自己（或 admin）');
    expect(guide).toContain('PATCH /admin/users/:id/status');
    expect(guide).toContain('confirmationAccountId');
  });
});
