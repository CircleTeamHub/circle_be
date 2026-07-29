/* eslint-disable */
/**
 * Local/dev fancy-number inventory seed.
 *
 * Adds a deterministic set of AVAILABLE numbers without modifying existing
 * leases, purchases, users, or occupied account identifiers. Safe to rerun.
 *
 * Run: npm run seed:fancy-numbers
 */
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../src/generated/prisma');
const { assertDevSeedAllowed } = require('./seed-guard');
const { deterministicUuid } = require('./deterministic-id.cjs');

if (!process.env.DATABASE_URL) {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env.development');
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .find((item) => item.startsWith('DATABASE_URL='));
  if (line) {
    process.env.DATABASE_URL = line
      .slice('DATABASE_URL='.length)
      .replace(/"/g, '')
      .trim();
  }
}

assertDevSeedAllowed(process.env);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const INVENTORY = [
  '8888',
  '6666',
  '9999',
  '888888',
  '666666',
  '999999',
  '777777',
  '520520',
  '168168',
  '1314520',
  '10000001',
  '12345678',
];

async function main() {
  const result = await prisma.$transaction(async (tx) => {
    const summary = { created: [], existing: [], skipped: [] };

    for (const [sortOrder, value] of INVENTORY.entries()) {
      const identifier = await tx.accountIdentifier.findUnique({
        where: { value },
        select: {
          currentUserID: true,
          reservedForUserID: true,
          inviteOwnerUserID: true,
          fancyNumber: { select: { id: true, status: true } },
        },
      });

      if (identifier?.fancyNumber) {
        summary.existing.push(value);
        continue;
      }
      if (
        identifier?.currentUserID ||
        identifier?.reservedForUserID ||
        identifier?.inviteOwnerUserID
      ) {
        summary.skipped.push(value);
        continue;
      }

      if (!identifier) {
        await tx.accountIdentifier.create({ data: { value } });
      }
      await tx.fancyNumber.create({
        data: {
          id: deterministicUuid('fancy-number-seed:', value),
          value,
          status: 'AVAILABLE',
          source: 'ADMIN',
          sortOrder,
        },
      });
      summary.created.push(value);
    }

    return summary;
  });

  console.log('Fancy-number seed complete:', result);
}

main()
  .catch((error) => {
    console.error('FANCY-NUMBER SEED FAILED:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
