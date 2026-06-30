/* eslint-disable */
/**
 * Dev-only helper: grant every first-release system badge to one user.
 *
 * Run:
 *   node scripts/grant-all-badges.js
 *   node scripts/grant-all-badges.js user@example.com
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../src/generated/prisma');
const { assertDevSeedAllowed } = require('./seed-guard');

const DEFAULT_EMAIL = '932567218@qq.com';
const email = String(process.argv[2] ?? DEFAULT_EMAIL)
  .trim()
  .toLowerCase();

const SYSTEM_BADGES = [
  'VIP',
  'NEW_USER',
  'TOP_COLLABORATOR',
  'VERIFIED_PROFILE',
  'CIRCLE_BUILDER',
];

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return;
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

function det(key) {
  const h = crypto
    .createHash('sha1')
    .update(`circle-badge-seed:${key}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

loadDatabaseUrl();
assertDevSeedAllowed(process.env);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, accountId: true, email: true, nickname: true },
  });

  if (!user) {
    throw new Error(`User with email ${email} was not found.`);
  }

  const now = new Date();
  const matureCircleCreatedAt = new Date(
    now.getTime() - 8 * 24 * 60 * 60 * 1000,
  );
  const circleId = det(`builder-circle:${user.id}`);
  const iconAssetId = det(`builder-circle-icon:${user.id}`);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        status: 'ACTIVE',
        vipLevel: 5,
        creditScore: 100,
        fancyNumber: true,
        receivedLikeCount: 10_000,
        createdAt: now,
        qq: '932567218',
        wechat: 'windnote_test_932567218',
        phoneNumber: '13800138000',
        iconPreferencesInitialized: true,
      },
    });

    await tx.userPrivacySetting.upsert({
      where: { userID: user.id },
      update: {
        showPhone: true,
        showWechat: true,
        showQQ: true,
      },
      create: {
        id: det(`privacy:${user.id}`),
        userID: user.id,
        showPhone: true,
        showWechat: true,
        showQQ: true,
      },
    });

    await tx.circle.upsert({
      where: { id: circleId },
      update: {
        name: 'Badge 全量测试圈',
        description: '用于测试圈子建设者和圈子 Badge 的本地测试圈。',
        ownerID: user.id,
        memberCount: 101,
        deleted: false,
        isPublic: false,
        createdAt: matureCircleCreatedAt,
      },
      create: {
        id: circleId,
        name: 'Badge 全量测试圈',
        description: '用于测试圈子建设者和圈子 Badge 的本地测试圈。',
        ownerID: user.id,
        memberCount: 101,
        deleted: false,
        isPublic: false,
        createdAt: matureCircleCreatedAt,
      },
    });

    await tx.iconAsset.upsert({
      where: { id: iconAssetId },
      update: {
        name: 'Badge 测试圈图标',
        sourceType: 'CIRCLE',
        imageUrl: null,
        circleID: circleId,
        createdByID: user.id,
      },
      create: {
        id: iconAssetId,
        name: 'Badge 测试圈图标',
        sourceType: 'CIRCLE',
        imageUrl: null,
        circleID: circleId,
        createdByID: user.id,
      },
    });

    await tx.circle.update({
      where: { id: circleId },
      data: { currentIconAssetID: iconAssetId },
    });

    await tx.circleMember.upsert({
      where: { userID_circleID: { userID: user.id, circleID: circleId } },
      update: { role: 'OWNER', status: 'ACTIVE' },
      create: {
        id: det(`builder-member:${user.id}`),
        userID: user.id,
        circleID: circleId,
        role: 'OWNER',
        status: 'ACTIVE',
      },
    });

    await tx.userDisplayIcon.deleteMany({
      where: { userID: user.id },
    });

    await tx.userDisplayIcon.createMany({
      data: SYSTEM_BADGES.map((systemKey, sortOrder) => ({
        userID: user.id,
        displayType: 'SYSTEM',
        systemKey,
        circleID: null,
        sortOrder,
      })),
    });
  });

  const refreshed = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      accountId: true,
      email: true,
      nickname: true,
      vipLevel: true,
      receivedLikeCount: true,
      createdAt: true,
      qq: true,
      wechat: true,
      phoneNumber: true,
      displayIcons: {
        orderBy: { sortOrder: 'asc' },
        select: {
          displayType: true,
          systemKey: true,
          circleID: true,
          sortOrder: true,
        },
      },
    },
  });

  console.log('Granted all first-release system badges:', refreshed);
  console.log('Available system badges:', SYSTEM_BADGES.join(', '));
  console.log('Builder test circle:', circleId);
}

main()
  .catch((error) => {
    console.error('GRANT BADGES FAILED:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
