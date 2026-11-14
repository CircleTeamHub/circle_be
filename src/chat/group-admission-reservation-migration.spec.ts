import { readFileSync } from 'fs';

it('keeps legacy inserts reserving consent-free capacity during blue-green rollout', () => {
  const trigger = readFileSync(
    'prisma/migrations/20261113000100_group_admission_consent_reservation_trigger/migration.sql',
    'utf8',
  );
  expect(trigger).toContain('BEFORE INSERT ON "GroupAdmission"');
  expect(trigger).toContain(`NEW."kind" = 'INVITE'`);
  expect(trigger).toContain(`NEW."status" = 'PENDING'`);
  expect(trigger).toContain('NEW."acceptedAt" IS NOT NULL');
  expect(trigger).not.toContain('BEFORE INSERT OR UPDATE');

  const backfill = readFileSync(
    'prisma/migrations/20261113000200_backfill_group_admission_consent_reservations/migration.sql',
    'utf8',
  );
  expect(backfill).toContain(`"status" = 'PENDING'`);
  expect(backfill).toContain('"acceptedAt" IS NOT NULL');
});
