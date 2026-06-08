/* eslint-disable */
/**
 * Test-data seeder (dev only).
 *
 * Creates accounts, circle memberships, posts, mutual sign-ups and friendships
 * so the circle/plaza + signup features can be exercised end to end.
 *
 * Chat history is intentionally NOT seeded: it lives in OpenIM (MongoDB), and
 * the OpenIM API is currently unreachable from this environment.
 *
 * Idempotent: seeded rows use deterministic IDs (sha1 of a stable key) and are
 * upserted, so re-running updates in place instead of duplicating.
 *
 * Run:  node scripts/seed-test-data.js
 */
const crypto = require('crypto');
const argon2 = require('argon2');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../src/generated/prisma');
const { assertDevSeedAllowed } = require('./seed-guard');

// Load DATABASE_URL from .env.development if not already in the environment.
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

const PASSWORD = 'Test1234';

/** Stable uuid-shaped id from a key, so upserts are idempotent across runs. */
function det(key) {
  const h = crypto
    .createHash('sha1')
    .update('circle-seed:' + key)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const EXISTING_CIRCLE_ID = '62043328-4ff9-4e53-b668-a70d6994ecd3'; // "Nbuuhbub", owner jimmy

const USERS = [
  {
    accountId: 'alice01',
    nickname: '小爱',
    vipLevel: 0,
    creditScore: 100,
    fancyNumber: false,
    gender: 'female',
    city: '北京',
  },
  {
    accountId: 'bob02',
    nickname: '大波',
    vipLevel: 1,
    creditScore: 85,
    fancyNumber: true,
    gender: 'male',
    city: '上海',
  },
  {
    accountId: 'carol03',
    nickname: '小卡',
    vipLevel: 2,
    creditScore: 70,
    fancyNumber: false,
    gender: 'female',
    city: '广州',
  },
  {
    accountId: 'dave04',
    nickname: '老戴',
    vipLevel: 3,
    creditScore: 95,
    fancyNumber: true,
    gender: 'male',
    city: '深圳',
  },
  {
    accountId: 'erin05',
    nickname: '伊琳',
    vipLevel: 0,
    creditScore: 60,
    fancyNumber: false,
    gender: 'female',
    city: '成都',
  },
  {
    accountId: 'frank06',
    nickname: '法兰克',
    vipLevel: 5,
    creditScore: 100,
    fancyNumber: true,
    gender: 'male',
    city: '杭州',
  },
  {
    accountId: 'grace07',
    nickname: '阿雅',
    vipLevel: 1,
    creditScore: 90,
    fancyNumber: false,
    gender: 'female',
    city: '武汉',
  },
  {
    accountId: 'henry08',
    nickname: '亨利',
    vipLevel: 2,
    creditScore: 80,
    fancyNumber: false,
    gender: 'male',
    city: '南京',
  },
];

// New circles owned by seeded users.
const CIRCLES = [
  {
    key: 'shanghai',
    name: '上海同城交友',
    ownerAccount: 'bob02',
    cities: ['上海'],
    categories: ['交友'],
    description: '上海本地交友圈，约饭约玩',
  },
  {
    key: 'shenzhen',
    name: '深圳户外运动',
    ownerAccount: 'dave04',
    cities: ['深圳', '广州'],
    categories: ['运动'],
    description: '深圳周边爬山、骑行、露营',
  },
];

// Membership: who is an ACTIVE member of which circle (besides each circle's owner).
// frank06 is the all-in-one test account: member of every circle so one login
// can see all feeds + group chats.
const MEMBERSHIPS = {
  existing: [
    'alice01',
    'bob02',
    'carol03',
    'dave04',
    'erin05',
    'frank06',
    'grace07',
    'henry08',
    'pubg',
    'tom123',
  ],
  shanghai: ['alice01', 'carol03', 'erin05', 'grace07', 'jimmy', 'frank06'],
  shenzhen: ['frank06', 'henry08', 'carol03', 'tom123'],
};

// circleRef: 'existing' | 'shanghai' | 'shenzhen'
const POSTS = [
  {
    key: 'p1',
    author: 'bob02',
    circle: 'shanghai',
    city: '上海',
    content: '周五晚陆家嘴小酒馆，约三五好友聊聊天～',
    r: {},
  },
  {
    key: 'p2',
    author: 'alice01',
    circle: 'shanghai',
    city: '上海',
    content: '有没有一起看周末漫展的小伙伴？',
    r: { signupCredit: 80 },
  },
  {
    key: 'p3',
    author: 'carol03',
    circle: 'shanghai',
    city: '上海',
    content: '想组个桌游局，狼人杀/剧本杀都行',
    r: { signupVip: 1 },
  },
  {
    key: 'p4',
    author: 'dave04',
    circle: 'shenzhen',
    city: '深圳',
    content: '本周日梧桐山徒步，早上8点集合',
    r: {},
  },
  {
    key: 'p5',
    author: 'frank06',
    circle: 'shenzhen',
    city: '深圳',
    content: '招募骑行搭子，环大鹏湾路线',
    r: { signupVip: 2, signupCredit: 70 },
  },
  {
    key: 'p6',
    author: 'henry08',
    circle: 'shenzhen',
    city: '广州',
    content: '广州露营，需要靓号车友拼车',
    r: { signupFancy: true },
  },
  {
    key: 'p7',
    author: 'grace07',
    circle: 'existing',
    city: '武汉',
    content: '武汉的朋友周末约个饭呀',
    r: { signupCredit: 90 },
  },
  {
    key: 'p8',
    author: 'erin05',
    circle: 'existing',
    city: '成都',
    content: '成都喝茶打麻将，三缺一',
    r: {},
  },
  {
    key: 'p9',
    author: 'jimmy',
    circle: 'existing',
    city: '张家口',
    content: '滑雪季来啦，崇礼约起',
    r: { signupVip: 1 },
  },
  // frank06 (主测试号) 自己发的帖子，分布在多个圈子，便于测「我的帖子 / 报名管理」。
  {
    key: 'p10',
    author: 'frank06',
    circle: 'shanghai',
    city: '上海',
    content: '杭州周末来上海，约个饭局～',
    r: { signupVip: 2 },
  },
  {
    key: 'p11',
    author: 'frank06',
    circle: 'existing',
    city: '杭州',
    content: '西湖夜骑，有一起的吗',
    r: {},
  },
];

// Mutual sign-ups. seen=false marks an unread signup for the post author's badge.
const SIGNUPS = [
  { post: 'p1', by: 'alice01', seen: false },
  { post: 'p1', by: 'carol03', seen: true },
  { post: 'p1', by: 'frank06', seen: false },
  { post: 'p4', by: 'frank06', seen: false },
  { post: 'p4', by: 'henry08', seen: true },
  { post: 'p4', by: 'carol03', seen: false },
  { post: 'p2', by: 'grace07', seen: false },
  { post: 'p8', by: 'bob02', seen: false },
  { post: 'p8', by: 'dave04', seen: true },
  { post: 'p9', by: 'frank06', seen: false },
  { post: 'p9', by: 'bob02', seen: false },
  { post: 'p5', by: 'dave04', seen: false },
  { post: 'p3', by: 'erin05', seen: false },
  // 报名 frank06 的帖子 —— 多个未读，方便测报名管理列表 + 未读红点。
  { post: 'p5', by: 'henry08', seen: true },
  { post: 'p5', by: 'carol03', seen: false },
  { post: 'p10', by: 'alice01', seen: false },
  { post: 'p10', by: 'carol03', seen: false },
  { post: 'p10', by: 'grace07', seen: true },
  { post: 'p11', by: 'bob02', seen: false },
  { post: 'p11', by: 'erin05', seen: false },
  { post: 'p11', by: 'tom123', seen: true },
];

// Accepted friendships (one row per pair is enough — listFriends matches both directions).
const FRIENDS = [
  ['alice01', 'bob02'],
  ['alice01', 'carol03'],
  ['bob02', 'dave04'],
  ['carol03', 'erin05'],
  ['frank06', 'henry08'],
  ['grace07', 'alice01'],
  ['jimmy', 'bob02'],
  ['tom123', 'carol03'],
  ['pubg', 'frank06'],
  ['dave04', 'henry08'],
  // frank06 (主测试号) 多个好友，便于测好友列表 + 单聊。
  ['frank06', 'bob02'],
  ['frank06', 'alice01'],
  ['frank06', 'dave04'],
  ['frank06', 'jimmy'],
];

async function main() {
  const passwordHash = await argon2.hash(PASSWORD);

  // 1) Users (upsert by accountId).
  for (const u of USERS) {
    await prisma.user.upsert({
      where: { accountId: u.accountId },
      update: {
        nickname: u.nickname,
        vipLevel: u.vipLevel,
        creditScore: u.creditScore,
        fancyNumber: u.fancyNumber,
        gender: u.gender,
        city: u.city,
        status: 'ACTIVE',
      },
      create: {
        id: det('user:' + u.accountId),
        accountId: u.accountId,
        passwordHash,
        nickname: u.nickname,
        vipLevel: u.vipLevel,
        creditScore: u.creditScore,
        fancyNumber: u.fancyNumber,
        gender: u.gender,
        city: u.city,
        status: 'ACTIVE',
        openimSynced: false,
      },
    });
  }

  // Build accountId -> id map for all referenced users.
  const allUsers = await prisma.user.findMany({
    select: { id: true, accountId: true },
  });
  const uid = Object.fromEntries(allUsers.map((u) => [u.accountId, u.id]));

  // 2) Circles (upsert by deterministic id) + owner membership.
  const circleId = { existing: EXISTING_CIRCLE_ID };
  for (const c of CIRCLES) {
    const id = det('circle:' + c.key);
    circleId[c.key] = id;
    const ownerID = uid[c.ownerAccount];
    await prisma.circle.upsert({
      where: { id },
      update: {
        name: c.name,
        description: c.description,
        cities: c.cities,
        categories: c.categories,
        isPublic: true,
        deleted: false,
      },
      create: {
        id,
        name: c.name,
        description: c.description,
        cities: c.cities,
        categories: c.categories,
        ownerID,
        isPublic: true,
      },
    });
    // Owner is an ACTIVE OWNER member.
    await prisma.circleMember.upsert({
      where: { userID_circleID: { userID: ownerID, circleID: id } },
      update: { role: 'OWNER', status: 'ACTIVE' },
      create: {
        id: det(`member:${c.key}:${c.ownerAccount}`),
        userID: ownerID,
        circleID: id,
        role: 'OWNER',
        status: 'ACTIVE',
      },
    });
  }

  // 3) Memberships (ACTIVE members).
  for (const [ref, accounts] of Object.entries(MEMBERSHIPS)) {
    const cid = circleId[ref];
    for (const acc of accounts) {
      const userID = uid[acc];
      if (!userID) continue;
      await prisma.circleMember.upsert({
        where: { userID_circleID: { userID, circleID: cid } },
        update: { status: 'ACTIVE' },
        create: {
          id: det(`member:${ref}:${acc}`),
          userID,
          circleID: cid,
          role: 'MEMBER',
          status: 'ACTIVE',
        },
      });
    }
  }

  // 4) Posts (upsert by deterministic id), spread createdAt over recent days.
  const postId = {};
  let dayOffset = POSTS.length;
  for (const p of POSTS) {
    const id = det('post:' + p.key);
    postId[p.key] = id;
    const createdAt = new Date(Date.now() - dayOffset-- * 6 * 60 * 60 * 1000); // ~6h apart
    await prisma.circlePost.upsert({
      where: { id },
      update: {
        content: p.content,
        city: p.city,
        signupVipRestriction: p.r.signupVip ?? null,
        signupCreditRestriction: p.r.signupCredit ?? null,
        signupFancyRestriction: p.r.signupFancy ?? false,
        status: 'ACTIVE',
      },
      create: {
        id,
        content: p.content,
        city: p.city,
        authorID: uid[p.author],
        circleID: circleId[p.circle],
        signupVipRestriction: p.r.signupVip ?? null,
        signupCreditRestriction: p.r.signupCredit ?? null,
        signupFancyRestriction: p.r.signupFancy ?? false,
        status: 'ACTIVE',
        createdAt,
      },
    });
  }

  // 5) Sign-ups (upsert by [postID, userID]).
  for (const sgn of SIGNUPS) {
    const pid = postId[sgn.post];
    const userID = uid[sgn.by];
    if (!pid || !userID) continue;
    await prisma.circlePostSignup.upsert({
      where: { postID_userID: { postID: pid, userID } },
      update: { seenByAuthor: sgn.seen, seenAt: sgn.seen ? new Date() : null },
      create: {
        id: det(`signup:${sgn.post}:${sgn.by}`),
        postID: pid,
        userID,
        seenByAuthor: sgn.seen,
        seenAt: sgn.seen ? new Date() : null,
      },
    });
  }

  // 6) Friendships (deterministic id per ordered pair; upsert by id).
  for (const [a, b] of FRIENDS) {
    const userID = uid[a];
    const friendID = uid[b];
    if (!userID || !friendID) continue;
    const id = det(`friend:${a}:${b}`);
    await prisma.friend.upsert({
      where: { id },
      update: { state: 'ACCEPTED' },
      create: { id, userID, friendID, state: 'ACCEPTED' },
    });
  }

  // 7) Recompute denormalized counters from actual rows.
  for (const cid of Object.values(circleId)) {
    const [memberCount, postCount] = await Promise.all([
      prisma.circleMember.count({ where: { circleID: cid, status: 'ACTIVE' } }),
      prisma.circlePost.count({ where: { circleID: cid, status: 'ACTIVE' } }),
    ]);
    await prisma.circle.update({
      where: { id: cid },
      data: { memberCount, postCount },
    });
  }
  for (const pid of Object.values(postId)) {
    const signupCount = await prisma.circlePostSignup.count({
      where: { postID: pid },
    });
    await prisma.circlePost.update({
      where: { id: pid },
      data: { signupCount },
    });
  }

  // Summary
  const [users, circles, members, posts, signups, friends] = await Promise.all([
    prisma.user.count(),
    prisma.circle.count(),
    prisma.circleMember.count(),
    prisma.circlePost.count(),
    prisma.circlePostSignup.count(),
    prisma.friend.count(),
  ]);
  console.log('Seed complete. Totals:', {
    users,
    circles,
    members,
    posts,
    signups,
    friends,
  });
  console.log(
    `Login password for all ${USERS.length} seeded accounts: ${PASSWORD}`,
  );
  console.log('Seeded accounts:', USERS.map((u) => u.accountId).join(', '));
}

main()
  .catch((e) => {
    console.error('SEED FAILED:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
