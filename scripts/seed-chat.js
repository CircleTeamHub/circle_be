/* eslint-disable */
/**
 * Chat-record seeder (dev only) — generates OpenIM single + group chat history
 * for the seeded accounts so the chat-history feature can be tested.
 *
 * Steps: register users in OpenIM -> create/sync circle groups -> send messages.
 * Every OpenIM call is best-effort and logs its errCode so partial failures
 * (e.g. "already registered") don't abort the run.
 *
 * Run:  node scripts/seed-chat.js
 */
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../src/generated/prisma');
const fs = require('fs');
const path = require('path');
const { assertDevSeedAllowed } = require('./seed-guard');

// --- config ---
function envVal(file, key) {
  const p = path.join(__dirname, '..', file);
  if (!fs.existsSync(p)) return undefined;
  const line = fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(key + '='));
  return line
    ? line
        .slice(key.length + 1)
        .replace(/"/g, '')
        .trim()
    : undefined;
}
process.env.DATABASE_URL =
  process.env.DATABASE_URL || envVal('.env.development', 'DATABASE_URL');
assertDevSeedAllowed(process.env);

const API = envVal('.env', 'OPENIM_API_URL') || 'http://127.0.0.1:10002';
const SECRET = envVal('.env', 'OPENIM_ADMIN_SECRET') || 'openIM123';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const toImUserId = (id) => id.replace(/-/g, '');
let adminToken = '';
const { randomUUID } = require('crypto');

async function im(pathName, body, useToken = true) {
  const res = await fetch(`${API}${pathName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      operationID: randomUUID(),
      ...(useToken && adminToken ? { token: adminToken } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

async function getAdminToken() {
  const r = await im(
    '/auth/get_admin_token',
    { secret: SECRET, platformID: 1, userID: 'imAdmin' },
    false,
  );
  if (r.errCode !== 0)
    throw new Error('admin token failed: ' + JSON.stringify(r));
  adminToken = r.data.token;
}

async function sendText({ from, fromNick, toUser, groupID }) {
  const base = {
    sendID: from,
    senderNickname: fromNick,
    senderPlatformID: 1,
    content: { content: arguments[0].text },
    contentType: 101, // Text
  };
  let body;
  if (groupID) {
    body = { ...base, groupID, sessionType: 3 }; // group
  } else {
    body = { ...base, recvID: toUser, sessionType: 1 }; // single
  }
  let r = await im('/msg/send_msg', body);
  // Fallback for groups: some deployments expect sessionType 2.
  if (r.errCode !== 0 && groupID) {
    r = await im('/msg/send_msg', { ...body, sessionType: 2 });
  }
  return r;
}

// --- conversation scripts (account ids) ---
const SINGLE_CHATS = [
  {
    a: 'alice01',
    b: 'bob02',
    msgs: [
      ['alice01', '在吗？周末漫展一起去不'],
      ['bob02', '去呀，几点的票'],
      ['alice01', '上午十点场，我多买了一张'],
      ['bob02', '那太好了，到时候门口见'],
    ],
  },
  {
    a: 'bob02',
    b: 'dave04',
    msgs: [
      ['bob02', '老戴，骑行那个路线确定了吗'],
      ['dave04', '环大鹏湾，全程40公里'],
      ['bob02', '有点猛啊哈哈，我尽量跟上'],
    ],
  },
  {
    a: 'carol03',
    b: 'erin05',
    msgs: [
      ['carol03', '成都那边天气咋样'],
      ['erin05', '阴天，适合喝茶打麻将😄'],
      ['carol03', '馋了，下个月去找你'],
    ],
  },
  {
    a: 'frank06',
    b: 'henry08',
    msgs: [
      ['frank06', '露营装备你带帐篷我带炉子？'],
      ['henry08', '行，水我也带点'],
    ],
  },
  {
    a: 'jimmy',
    b: 'bob02',
    msgs: [
      ['jimmy', '崇礼滑雪有兴趣不'],
      ['bob02', '雪季必须的，约'],
    ],
  },
  // frank06 (主测试号) 与多位好友的单聊，便于一个号测全部聊天。
  {
    a: 'frank06',
    b: 'bob02',
    msgs: [
      ['frank06', '上海饭局定哪天'],
      ['bob02', '周六中午怎么样'],
      ['frank06', '可以，我订位置'],
    ],
  },
  {
    a: 'frank06',
    b: 'alice01',
    msgs: [
      ['alice01', '法兰克你来上海记得喊我'],
      ['frank06', '必须的，到时一起'],
    ],
  },
  {
    a: 'frank06',
    b: 'dave04',
    msgs: [
      ['frank06', '骑行那天几点集合'],
      ['dave04', '早上七点半，别迟到'],
      ['frank06', '收到👌'],
    ],
  },
  {
    a: 'frank06',
    b: 'jimmy',
    msgs: [
      ['frank06', '崇礼滑雪算我一个'],
      ['jimmy', '好嘞，组个队'],
    ],
  },
];

// circleRef -> deterministic id (must match seed-test-data.js det())
const crypto = require('crypto');
const det = (key) => {
  const h = crypto
    .createHash('sha1')
    .update('circle-seed:' + key)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const CIRCLES = {
  existing: '62043328-4ff9-4e53-b668-a70d6994ecd3',
  shanghai: det('circle:shanghai'),
  shenzhen: det('circle:shenzhen'),
};
const GROUP_CHATS = [
  {
    ref: 'existing',
    msgs: [
      ['jimmy', '大家好，欢迎进圈～'],
      ['grace07', '哈喽各位'],
      ['erin05', '冒个泡，成都的'],
    ],
  },
  {
    ref: 'shanghai',
    msgs: [
      ['bob02', '上海同城群建起来了'],
      ['alice01', '撒花🎉'],
      ['carol03', '周末有局喊我'],
      ['frank06', '杭州的也混进来了哈哈'],
    ],
  },
  {
    ref: 'shenzhen',
    msgs: [
      ['dave04', '周日梧桐山徒步，报名的接龙'],
      ['frank06', '+1'],
      ['henry08', '+1，带相机'],
    ],
  },
];

async function main() {
  await getAdminToken();
  console.log('admin token ok');

  // accounts we touch
  const accounts = new Set();
  for (const c of SINGLE_CHATS) c.msgs.forEach((m) => accounts.add(m[0]));
  for (const c of GROUP_CHATS) c.msgs.forEach((m) => accounts.add(m[0]));
  const users = await prisma.user.findMany({
    where: { accountId: { in: [...accounts] } },
    select: { id: true, accountId: true, nickname: true, avatarUrl: true },
  });
  const byAcc = Object.fromEntries(users.map((u) => [u.accountId, u]));

  // 1) register all touched users in OpenIM (idempotent: ignore "already registered")
  let reg = 0;
  for (const u of users) {
    const r = await im('/user/user_register', {
      users: [
        {
          userID: toImUserId(u.id),
          nickname: u.nickname,
          faceURL: u.avatarUrl ?? '',
        },
      ],
    });
    if (r.errCode === 0) reg++;
    else if (!/registered|exist/i.test(r.errMsg || ''))
      console.log('  register warn', u.accountId, r.errCode, r.errMsg);
  }
  await prisma.user.updateMany({
    where: { id: { in: users.map((u) => u.id) } },
    data: { openimSynced: true },
  });
  console.log(`users registered (new): ${reg}/${users.length}`);

  // 2) ensure circle groups exist with members; set DB groupID
  for (const ref of Object.keys(CIRCLES)) {
    const cid = CIRCLES[ref];
    const circle = await prisma.circle.findUnique({
      where: { id: cid },
      select: { id: true, name: true, ownerID: true },
    });
    if (!circle) {
      console.log('  circle missing', ref);
      continue;
    }
    const members = await prisma.circleMember.findMany({
      where: { circleID: cid, status: 'ACTIVE' },
      select: { userID: true },
    });
    const ownerIm = toImUserId(circle.ownerID);
    const memberIms = members
      .map((m) => toImUserId(m.userID))
      .filter((x) => x !== ownerIm);
    const cr = await im('/group/create_group', {
      ownerUserID: ownerIm,
      memberUserIDs: memberIms,
      groupInfo: { groupID: cid, groupName: circle.name, groupType: 2 },
    });
    if (cr.errCode === 0) {
      console.log(
        `  group created: ${ref} (${circle.name}) +${memberIms.length} members`,
      );
    } else if (/exist/i.test(cr.errMsg || '')) {
      // already exists — make sure members are in it
      await im('/group/invite_user_to_group', {
        groupID: cid,
        invitedUserIDs: memberIms,
        reason: '',
      });
      console.log(`  group exists: ${ref}, ensured members`);
    } else {
      console.log(`  group create warn ${ref}:`, cr.errCode, cr.errMsg);
    }
    await prisma.circle.update({ where: { id: cid }, data: { groupID: cid } });
  }

  // 3) single chats
  let sOk = 0,
    sFail = 0;
  for (const conv of SINGLE_CHATS) {
    for (const [fromAcc, text] of conv.msgs) {
      const peer = conv.a === fromAcc ? conv.b : conv.a;
      const from = byAcc[fromAcc],
        to = byAcc[peer];
      if (!from || !to) continue;
      const r = await sendText({
        from: toImUserId(from.id),
        fromNick: from.nickname,
        toUser: toImUserId(to.id),
        text,
      });
      r.errCode === 0
        ? sOk++
        : (sFail++,
          console.log(
            '  single fail',
            fromAcc,
            '->',
            peer,
            r.errCode,
            r.errMsg,
          ));
    }
  }
  console.log(`single messages: ok=${sOk} fail=${sFail}`);

  // 4) group chats
  let gOk = 0,
    gFail = 0;
  for (const conv of GROUP_CHATS) {
    const gid = CIRCLES[conv.ref];
    for (const [fromAcc, text] of conv.msgs) {
      const from = byAcc[fromAcc];
      if (!from) continue;
      const r = await sendText({
        from: toImUserId(from.id),
        fromNick: from.nickname,
        groupID: gid,
        text,
      });
      r.errCode === 0
        ? gOk++
        : (gFail++,
          console.log('  group fail', conv.ref, fromAcc, r.errCode, r.errMsg));
    }
  }
  console.log(`group messages: ok=${gOk} fail=${gFail}`);
}

main()
  .catch((e) => {
    console.error('CHAT SEED FAILED:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
