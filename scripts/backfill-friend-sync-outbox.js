/* eslint-disable */
/**
 * Backfill OpenIM friend-sync outbox rows from existing business data.
 *
 * Dry run by default:
 *   node scripts/backfill-friend-sync-outbox.js
 *
 * Apply:
 *   node scripts/backfill-friend-sync-outbox.js --apply
 */

function addRow(rows, seen, operation, userID, targetUserID) {
  const key = `${operation}:${userID}:${targetUserID}`;
  if (seen.has(key)) return;
  seen.add(key);
  rows.push({ operation, userID, targetUserID });
}

function buildFriendSyncOutboxRows({ acceptedFriendships, blocks }) {
  const rows = [];
  const seen = new Set();

  for (const friendship of acceptedFriendships) {
    addRow(
      rows,
      seen,
      'IMPORT_FRIEND',
      friendship.userID,
      friendship.friendID,
    );
    addRow(
      rows,
      seen,
      'IMPORT_FRIEND',
      friendship.friendID,
      friendship.userID,
    );
  }

  for (const block of blocks) {
    addRow(rows, seen, 'ADD_BLACKLIST', block.blockerID, block.blockedID);
    addRow(rows, seen, 'DELETE_FRIEND', block.blockerID, block.blockedID);
    addRow(rows, seen, 'DELETE_FRIEND', block.blockedID, block.blockerID);
  }

  return rows;
}

async function backfillFriendSyncOutbox(prisma, { dryRun = true } = {}) {
  const [acceptedFriendships, blocks] = await Promise.all([
    prisma.friend.findMany({
      where: { state: 'ACCEPTED' },
      select: { userID: true, friendID: true },
    }),
    prisma.block.findMany({
      select: { blockerID: true, blockedID: true },
    }),
  ]);

  const rows = buildFriendSyncOutboxRows({ acceptedFriendships, blocks });
  if (dryRun || rows.length === 0) {
    return { planned: rows.length, created: 0, dryRun };
  }

  const result = await prisma.friendSyncOutbox.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return { planned: rows.length, created: result.count, dryRun };
}

function loadDatabaseUrlFromEnvFile() {
  if (process.env.DATABASE_URL) return;

  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env.development');
  if (!fs.existsSync(envPath)) return;

  const line = fs
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('DATABASE_URL='));
  if (!line) return;

  process.env.DATABASE_URL = line
    .slice('DATABASE_URL='.length)
    .replace(/"/g, '')
    .trim();
}

async function main() {
  const dryRun = !process.argv.includes('--apply');
  loadDatabaseUrlFromEnvFile();

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('../src/generated/prisma');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const result = await backfillFriendSyncOutbox(prisma, { dryRun });
    console.log(
      `friend sync outbox backfill: planned=${result.planned} created=${result.created} dryRun=${result.dryRun}`,
    );
    if (dryRun) {
      console.log('Run with --apply to write rows.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  backfillFriendSyncOutbox,
  buildFriendSyncOutboxRows,
};
