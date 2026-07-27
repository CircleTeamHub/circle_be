/* eslint-disable */
/**
 * Dev-only helper: grant every first-release system badge to one user.
 *
 * Run:
 *   node scripts/grant-all-badges.js
 *   node scripts/grant-all-badges.js user@example.com
 */
const fs = require('fs');
const path = require('path');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../src/generated/prisma');
const { assertDevSeedAllowed } = require('./seed-guard');
const {
  deterministicUuid,
  legacyDeterministicId,
} = require('./deterministic-id.cjs');

const DEFAULT_EMAIL = '932567218@qq.com';
const email = String(process.argv[2] ?? DEFAULT_EMAIL)
  .trim()
  .toLowerCase();

const SYSTEM_BADGES = [
  { systemKey: 'VIP', systemVariant: 'VIP1', label: 'VIP1' },
  { systemKey: 'VIP', systemVariant: 'VIP2', label: 'VIP2' },
  { systemKey: 'VIP', systemVariant: 'VIP3', label: 'VIP3' },
  { systemKey: 'VIP', systemVariant: 'VIP4', label: 'VIP4' },
  {
    systemKey: 'TOP_COLLABORATOR',
    systemVariant: 'TOP_COLLABORATOR_1',
    label: '合作达人1',
  },
  {
    systemKey: 'TOP_COLLABORATOR',
    systemVariant: 'TOP_COLLABORATOR_2',
    label: '合作达人2',
  },
  {
    systemKey: 'TOP_COLLABORATOR',
    systemVariant: 'TOP_COLLABORATOR_3',
    label: '合作达人3',
  },
  { systemKey: 'NEW_USER', systemVariant: 'NEW_USER', label: '新手' },
  {
    systemKey: 'VERIFIED_PROFILE',
    systemVariant: 'VERIFIED_PROFILE',
    label: '资料可信',
  },
  {
    systemKey: 'CIRCLE_BUILDER',
    systemVariant: 'CIRCLE_BUILDER',
    label: '圈子建设者',
  },
];

const DEFAULT_DISPLAY_BADGES = [
  'VIP4',
  'NEW_USER',
  'TOP_COLLABORATOR_3',
  'VERIFIED_PROFILE',
  'CIRCLE_BUILDER',
];

const VERIFIED_PROFILE_FALLBACKS = {
  avatarUrl:
    'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=256&h=256&fit=crop',
  city: '上海',
  persona: 'Badge 全量测试账号，用于本地验证所有系统图标展示。',
};

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
  return legacyDeterministicId('circle-badge-seed:', key);
}

function legacyDet(key) {
  return legacyDeterministicId('circle-badge-seed:', key);
}

function presentOrFallback(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : fallback;
}

function longTextOrFallback(value, fallback, minLength = 10) {
  return typeof value === 'string' && value.trim().length >= minLength
    ? value
    : fallback;
}

loadDatabaseUrl();
assertDevSeedAllowed(process.env);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      accountId: true,
      email: true,
      nickname: true,
      avatarUrl: true,
      city: true,
      persona: true,
    },
  });

  if (!user) {
    throw new Error(`User with email ${email} was not found.`);
  }

  const now = new Date();
  const matureCircleCreatedAt = new Date(
    now.getTime() - 8 * 24 * 60 * 60 * 1000,
  );
  const circleId = deterministicUuid(
    'circle-badge-seed:',
    `builder-circle:${user.id}`,
  );
  const legacyCircleId = legacyDet(`builder-circle:${user.id}`);
  const iconAssetId = det(`builder-circle-icon:${user.id}`);
  const membershipGrantId = det(`membership-grant:${user.id}`);
  const membershipGrantIdempotencyKey = `grant-all-badges:${user.id}:4`;

  await prisma.$transaction(async (tx) => {
    if (legacyCircleId !== circleId) {
      const legacyCircle = await tx.circle.findUnique({
        where: { id: legacyCircleId },
        select: { id: true, groupID: true },
      });
      if (legacyCircle) {
        const currentCircle = await tx.circle.findUnique({
          where: { id: circleId },
          select: { id: true },
        });
        if (currentCircle) {
          await tx.circle.update({
            where: { id: legacyCircleId },
            data: { deleted: true, groupID: null },
          });
        } else {
          await tx.circle.update({
            where: { id: legacyCircleId },
            data: {
              id: circleId,
              groupID:
                legacyCircle.groupID === legacyCircleId
                  ? circleId
                  : legacyCircle.groupID,
            },
          });
        }
      }
    }

    await tx.user.update({
      where: { id: user.id },
      data: {
        status: 'ACTIVE',
        vipLevel: 4,
        // Super is lifetime; the audited grant flow sets a null expiry, so match
        // it here instead of leaving a stale expiry from a prior lower tier.
        vipExpiresAt: null,
        creditScore: 100,
        fancyNumber: true,
        receivedLikeCount: 10_000,
        createdAt: now,
        avatarUrl: presentOrFallback(
          user.avatarUrl,
          VERIFIED_PROFILE_FALLBACKS.avatarUrl,
        ),
        city: presentOrFallback(user.city, VERIFIED_PROFILE_FALLBACKS.city),
        persona: longTextOrFallback(
          user.persona,
          VERIFIED_PROFILE_FALLBACKS.persona,
        ),
        qq: '932567218',
        wechat: 'windnote_test_932567218',
        phoneNumber: '13800138000',
        iconPreferencesInitialized: true,
      },
    });

    // Route the super membership through the audited grant shape instead of a
    // bare vipLevel write. A VIP4 member produced by the admin grant API always
    // carries a MembershipGrant (audit row) plus the PREMIUM_FANCY_NUMBER
    // benefit grant; synthesizing the same rows here (operator = self, mirroring
    // the legacy-benefit backfill migration) keeps badge/membership tests on
    // state the admin API can actually produce. Idempotent via the unique
    // idempotencyKey and (userID, type) so reruns never double-grant.
    await tx.membershipGrant.upsert({
      where: { idempotencyKey: membershipGrantIdempotencyKey },
      update: {},
      create: {
        id: membershipGrantId,
        idempotencyKey: membershipGrantIdempotencyKey,
        targetUserID: user.id,
        operatorUserID: user.id,
        previousLevel: 0,
        previousEffectiveLevel: 0,
        newLevel: 4,
        previousExpiresAt: null,
        newExpiresAt: null,
        benefitTypesSnapshot: ['PREMIUM_FANCY_NUMBER'],
        note: 'grant-all-badges dev seed: super membership via audited grant shape',
      },
    });
    await tx.membershipBenefitGrant.upsert({
      where: {
        userID_type: { userID: user.id, type: 'PREMIUM_FANCY_NUMBER' },
      },
      update: {},
      create: {
        id: det(`membership-benefit:${user.id}:PREMIUM_FANCY_NUMBER`),
        userID: user.id,
        membershipGrantID: membershipGrantId,
        type: 'PREMIUM_FANCY_NUMBER',
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
        createdAt: matureCircleCreatedAt,
      },
      create: {
        id: circleId,
        name: 'Badge 全量测试圈',
        description: '用于测试圈子建设者和圈子 Badge 的本地测试圈。',
        ownerID: user.id,
        memberCount: 101,
        deleted: false,
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
      data: DEFAULT_DISPLAY_BADGES.map((systemVariant, sortOrder) => {
        const badge = SYSTEM_BADGES.find(
          (item) => item.systemVariant === systemVariant,
        );
        if (!badge) {
          throw new Error(`Unknown default badge variant: ${systemVariant}`);
        }

        return {
          userID: user.id,
          displayType: 'SYSTEM',
          systemKey: badge.systemKey,
          systemVariant: badge.systemVariant,
          circleID: null,
          sortOrder,
        };
      }),
    });
  });

  // Assert the audited membership rows exist. The seed must reproduce the exact
  // shape the admin grant API creates (grant + benefit), or badge/membership
  // tests would silently run on an impossible bare-vipLevel state.
  const membershipAudit = await prisma.membershipGrant.findUnique({
    where: { idempotencyKey: membershipGrantIdempotencyKey },
    select: {
      newLevel: true,
      benefitGrants: { select: { type: true } },
    },
  });
  const seededUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { vipLevel: true, vipExpiresAt: true },
  });
  if (
    !membershipAudit ||
    membershipAudit.newLevel !== 4 ||
    !membershipAudit.benefitGrants.some(
      (benefit) => benefit.type === 'PREMIUM_FANCY_NUMBER',
    ) ||
    seededUser?.vipLevel !== 4 ||
    seededUser?.vipExpiresAt !== null
  ) {
    throw new Error(
      'Audited membership grant/benefit rows were not created for the seeded super member; refusing to report success.',
    );
  }

  const refreshed = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      accountId: true,
      email: true,
      nickname: true,
      avatarUrl: true,
      city: true,
      persona: true,
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
          systemVariant: true,
          circleID: true,
          sortOrder: true,
        },
      },
    },
  });

  console.log('Granted all first-release system badges:', refreshed);
  console.log(
    'Available system badges:',
    SYSTEM_BADGES.map((item) => item.label).join(', '),
  );
  console.log('Builder test circle:', circleId);
}

main()
  .catch((error) => {
    console.error('GRANT BADGES FAILED:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
