/* eslint-disable */
/**
 * Local/dev admin seed.
 *
 * Creates or updates a deterministic ADMIN account for the admin web. The guard
 * rejects production and non-local database URLs unless ALLOW_NON_LOCAL_SEED is
 * explicitly set.
 */
const argon2 = require('argon2');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../src/generated/prisma');
const { assertDevSeedAllowed } = require('./seed-guard');

if (!process.env.DATABASE_URL) {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env.development');
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('DATABASE_URL='));
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

const accountId = process.env.ADMIN_SEED_ACCOUNT_ID || 'admin';
const email = process.env.ADMIN_SEED_EMAIL || 'admin@local.dev';
const password = process.env.ADMIN_SEED_PASSWORD || 'Admin1234!';

async function main() {
  const passwordHash = await argon2.hash(password);
  const user = await prisma.user.upsert({
    where: { accountId },
    update: {
      passwordHash,
      nickname: 'Local Admin',
      email,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
    create: {
      accountId,
      email,
      passwordHash,
      nickname: 'Local Admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      openimSynced: false,
    },
  });

  console.log('Admin seed ready:', {
    id: user.id,
    accountId,
    email,
    password,
    role: user.role,
    status: user.status,
  });
}

main()
  .catch((error) => {
    console.error('ADMIN SEED FAILED:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
