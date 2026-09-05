import { readFileSync } from 'node:fs';

describe('direct auto reply data lifecycle migration', () => {
  it('cascades jobs with source messages and states with conversations and responders', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    const migration = readFileSync(
      'prisma/migrations/20260904050000_add_direct_auto_reply/migration.sql',
      'utf8',
    );

    expect(schema).toMatch(
      /sourceMessage\s+ChatMessage\s+@relation\([^\n]+onDelete: Cascade\)/,
    );
    expect(schema).toMatch(
      /conversation\s+ChatConversation\s+@relation\([^\n]+onDelete: Cascade\)/,
    );
    expect(schema).toMatch(
      /responder\s+User\s+@relation\([^\n]+onDelete: Cascade\)/,
    );
    expect(migration).toContain(
      'FOREIGN KEY ("sourceMessageID") REFERENCES "ChatMessage"("id") ON DELETE CASCADE',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("conversationID") REFERENCES "ChatConversation"("id") ON DELETE CASCADE',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("responderID") REFERENCES "User"("id") ON DELETE CASCADE',
    );
  });

  it('indexes both retention cleanup scans', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    const migration = readFileSync(
      'prisma/migrations/20260904050000_add_direct_auto_reply/migration.sql',
      'utf8',
    );

    expect(schema).toMatch(/@@index\(\[status, updatedAt\]\)/);
    expect(schema).toMatch(/@@index\(\[updatedAt\]\)/);
    expect(migration).toContain(
      'CREATE INDEX "ChatDirectAutoReplyJob_status_updatedAt_idx"',
    );
    expect(migration).toContain(
      'CREATE INDEX "ChatDirectAutoReplyState_updatedAt_idx"',
    );
  });
});
