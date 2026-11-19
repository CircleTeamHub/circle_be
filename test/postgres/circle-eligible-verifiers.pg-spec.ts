import {
  eligibleVerifierIdsQuery,
  mutualDirectChatQuery,
} from 'src/circle-invitation/eligible-verifiers.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 可挑验证人 = 本圈 ACTIVE 成员 ∩ (申请人的已接受好友 ∪ 和申请人私聊过的人)
 * − 排除名单，按入圈先后。好友一侧口径对齐旧实现（成员全量 + 两个 IN 查好友 +
 * 内存求交）的每个分支；成本上不再把整圈成员搬出来，好友一侧走 Friend 的成对索引收窄。
 * 「私聊过」= 私聊里双方都发过言、且申请人这边还能搜到。
 */
describePostgres('circle eligible verifiers query (PostgreSQL)', () => {
  let s: IsolatedSchema;

  const eligible = async (params: {
    circleId?: string;
    callerId?: string;
    excludedUserIds?: string[];
  }) => {
    const q = eligibleVerifierIdsQuery({
      circleId: params.circleId ?? 'circle-1',
      callerId: params.callerId ?? 'applicant',
      excludedUserIds: params.excludedUserIds ?? ['applicant'],
    });
    const { rows } = await s.db.query<{ userID: string }>(q.text, q.values);
    return rows.map((row) => row.userID);
  };

  const member = async (
    userID: string,
    joinedAt: string,
    extra: { circleID?: string; status?: string } = {},
  ) => {
    await s.db.query(
      `INSERT INTO "CircleMember" (id, "userID", "circleID", status, "createdAt")
       VALUES ($1, $2, $3, $4, $5)`,
      [
        `m-${userID}-${extra.circleID ?? 'circle-1'}`,
        userID,
        extra.circleID ?? 'circle-1',
        extra.status ?? 'ACTIVE',
        joinedAt,
      ],
    );
  };

  let friendRow = 0;
  const friend = async (
    userID: string,
    friendID: string,
    state = 'ACCEPTED',
  ) => {
    friendRow += 1;
    await s.db.query(
      `INSERT INTO "Friend" (id, "userID", "friendID", state) VALUES ($1, $2, $3, $4)`,
      [`f-${friendRow}`, userID, friendID, state],
    );
  };

  const chatted = async (applicantId: string, peerId: string) => {
    const q = mutualDirectChatQuery({ applicantId, peerId });
    const { rows } = await s.db.query<{ chatted: boolean }>(q.text, q.values);
    return rows[0].chatted;
  };

  type MessageSpec = {
    from: string;
    height: number;
    deleted?: boolean;
    revokedAt?: string;
    burnExpiresAt?: string;
    content?: Record<string, unknown>;
  };

  let messageRow = 0;
  /** 申请人与 peer 的一段会话;默认 DIRECT、两个座位都在、没有清空过。 */
  const conversation = async (
    peer: string,
    messages: MessageSpec[],
    extra: {
      type?: string;
      conversationCleared?: number;
      applicantCleared?: number;
      applicantLeftAt?: string;
    } = {},
  ) => {
    const id = `conv-${peer}-${extra.type ?? 'DIRECT'}`;
    await s.db.query(
      `INSERT INTO "ChatConversation" (id, type, "clearedBeforeHeight") VALUES ($1, $2, $3)`,
      [id, extra.type ?? 'DIRECT', extra.conversationCleared ?? 0],
    );
    await s.db.query(
      `INSERT INTO "ChatMember" (id, "conversationID", "userID", "clearedBeforeHeight", "leftAt")
       VALUES ($1, $2, 'applicant', $3, $4), ($5, $2, $6, 0, NULL)`,
      [
        `seat-a-${id}`,
        id,
        extra.applicantCleared ?? 0,
        extra.applicantLeftAt ?? null,
        `seat-p-${id}`,
        peer,
      ],
    );
    for (const message of messages) {
      messageRow += 1;
      await s.db.query(
        `INSERT INTO "ChatMessage"
           (id, "conversationID", height, "senderID", content, "clientMessageId", deleted, "revokedAt", "burnExpiresAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          `msg-${messageRow}`,
          id,
          message.height,
          message.from,
          JSON.stringify(message.content ?? { text: 'hi' }),
          `client-${messageRow}`,
          message.deleted ?? false,
          message.revokedAt ?? null,
          message.burnExpiresAt ?? null,
        ],
      );
    }
  };

  const block = async (blockerID: string, blockedID: string) => {
    await s.db.query(
      `INSERT INTO "Block" (id, "blockerID", "blockedID") VALUES ($1, $2, $3)`,
      [`b-${blockerID}-${blockedID}`, blockerID, blockedID],
    );
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('circle_eligible_verifiers');
    await s.db.query(`
      CREATE TYPE "CircleMemberStatus" AS ENUM ('ACTIVE', 'PENDING', 'REJECTED');
      CREATE TYPE "FriendState" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');
      CREATE TYPE "ChatConversationType" AS ENUM ('DIRECT', 'GROUP', 'TEMP', 'SUPPORT');
      CREATE TABLE "ChatConversation" (
        id text PRIMARY KEY,
        type "ChatConversationType" NOT NULL,
        "clearedBeforeHeight" integer NOT NULL DEFAULT 0
      );
      CREATE TABLE "ChatMember" (
        id text PRIMARY KEY,
        "conversationID" text NOT NULL,
        "userID" text NOT NULL,
        "clearedBeforeHeight" integer NOT NULL DEFAULT 0,
        "leftAt" timestamp(3)
      );
      CREATE UNIQUE INDEX "ChatMember_conversationID_userID_key"
        ON "ChatMember" ("conversationID", "userID");
      CREATE INDEX "ChatMember_userID_idx" ON "ChatMember" ("userID");
      CREATE TABLE "ChatMessage" (
        id text PRIMARY KEY,
        "conversationID" text NOT NULL,
        height integer NOT NULL,
        "senderID" text,
        content jsonb NOT NULL,
        "clientMessageId" varchar(128),
        deleted boolean NOT NULL DEFAULT false,
        "revokedAt" timestamp(3),
        "burnExpiresAt" timestamp(3)
      );
      CREATE UNIQUE INDEX "ChatMessage_conversationID_senderID_clientMessageId_key"
        ON "ChatMessage" ("conversationID", "senderID", "clientMessageId");
      CREATE TABLE "Block" (
        id text PRIMARY KEY,
        "blockerID" text NOT NULL,
        "blockedID" text NOT NULL
      );
      CREATE UNIQUE INDEX "Block_blockerID_blockedID_key" ON "Block" ("blockerID", "blockedID");
      CREATE INDEX "Block_blockedID_idx" ON "Block" ("blockedID");
      CREATE TABLE "CircleMember" (
        id text PRIMARY KEY,
        "userID" text NOT NULL,
        "circleID" text NOT NULL,
        status "CircleMemberStatus" NOT NULL DEFAULT 'PENDING',
        "createdAt" timestamp(3) NOT NULL
      );
      CREATE UNIQUE INDEX "CircleMember_userID_circleID_key"
        ON "CircleMember" ("userID", "circleID");
      CREATE INDEX "CircleMember_circleID_status_userID_idx"
        ON "CircleMember" ("circleID", status, "userID");
      CREATE TABLE "Friend" (
        id text PRIMARY KEY,
        "userID" text NOT NULL,
        "friendID" text NOT NULL,
        state "FriendState" NOT NULL DEFAULT 'PENDING'
      );
      -- 与本批 Friend 成对索引迁移（20261026000200）一致的终态。
      CREATE INDEX "Friend_userID_friendID_idx" ON "Friend" ("userID", "friendID");
      CREATE INDEX "Friend_friendID_userID_idx" ON "Friend" ("friendID", "userID");
    `);
  });

  afterAll(async () => {
    await s?.close();
  });

  beforeEach(async () => {
    await s.db.query(
      'TRUNCATE "CircleMember", "Friend", "ChatConversation", "ChatMember", "ChatMessage", "Block"',
    );
  });

  it('admits a non-friend member once both sides have spoken in the direct chat', async () => {
    await member('late-chatted', '2026-03-01 00:00:00');
    await member('friend', '2026-02-01 00:00:00');
    await member('early-chatted', '2026-01-01 00:00:00');
    await member('applicant-only', '2026-01-02 00:00:00');
    await member('peer-only', '2026-01-03 00:00:00');
    await friend('applicant', 'friend');
    await conversation('late-chatted', [
      { from: 'applicant', height: 1 },
      { from: 'late-chatted', height: 2 },
    ]);
    await conversation('early-chatted', [
      { from: 'early-chatted', height: 1 },
      { from: 'applicant', height: 2 },
    ]);
    // 申请人单方面发「你好」,对方没回 —— 不算。
    await conversation('applicant-only', [
      { from: 'applicant', height: 1 },
      { from: 'applicant', height: 2 },
    ]);
    await conversation('peer-only', [{ from: 'peer-only', height: 1 }]);

    expect(await eligible({})).toEqual([
      'early-chatted',
      'friend',
      'late-chatted',
    ]);
    expect(await chatted('applicant', 'late-chatted')).toBe(true);
    expect(await chatted('applicant', 'applicant-only')).toBe(false);
    expect(await chatted('applicant', 'peer-only')).toBe(false);
    // 好友但没私聊过:私聊判定本身不成立(加席时由好友那条放行)。
    expect(await chatted('applicant', 'friend')).toBe(false);
  });

  it('only counts messages the applicant can still find', async () => {
    const peers = [
      'seat-cleared',
      'conversation-cleared',
      'deleted',
      'revoked',
      'burned',
      'left-seat',
      'burning-later',
    ];
    for (const [index, peer] of peers.entries()) {
      await member(peer, `2026-01-0${index + 1} 00:00:00`);
    }
    // 对方那句在申请人自己的清空水位之下。
    await conversation(
      'seat-cleared',
      [
        { from: 'seat-cleared', height: 1 },
        { from: 'applicant', height: 2 },
      ],
      { applicantCleared: 1 },
    );
    // 「删除所有人的记录」的会话水位。
    await conversation(
      'conversation-cleared',
      [
        { from: 'conversation-cleared', height: 1 },
        { from: 'applicant', height: 2 },
      ],
      { conversationCleared: 1 },
    );
    await conversation('deleted', [
      { from: 'deleted', height: 1, deleted: true },
      { from: 'applicant', height: 2 },
    ]);
    await conversation('revoked', [
      { from: 'revoked', height: 1, revokedAt: '2026-01-01 00:00:00' },
      { from: 'applicant', height: 2 },
    ]);
    // 焚毁期限已过、清理任务还没来得及把它标成 deleted。
    await conversation('burned', [
      { from: 'burned', height: 1, burnExpiresAt: '2000-01-01 00:00:00' },
      { from: 'applicant', height: 2 },
    ]);
    // 申请人这边的座位已退出,全局搜索也搜不到这段。
    await conversation(
      'left-seat',
      [
        { from: 'left-seat', height: 1 },
        { from: 'applicant', height: 2 },
      ],
      { applicantLeftAt: '2026-01-01 00:00:00' },
    );
    // 还没到焚毁期限:现在还看得见,照算。
    await conversation('burning-later', [
      {
        from: 'burning-later',
        height: 1,
        burnExpiresAt: '2999-01-01 00:00:00',
      },
      { from: 'applicant', height: 2 },
    ]);

    expect(await eligible({})).toEqual(['burning-later']);
  });

  it('ignores group chats, auto replies and blocked pairs in either direction', async () => {
    for (const [index, peer] of [
      'group-mate',
      'auto-replier',
      'blocked-by-applicant',
      'blocked-applicant',
    ].entries()) {
      await member(peer, `2026-01-0${index + 1} 00:00:00`);
    }
    await conversation(
      'group-mate',
      [
        { from: 'group-mate', height: 1 },
        { from: 'applicant', height: 2 },
      ],
      { type: 'GROUP' },
    );
    // 对方开着自动回复:那是服务端代发,不是对方说的话。
    await conversation('auto-replier', [
      { from: 'applicant', height: 1 },
      {
        from: 'auto-replier',
        height: 2,
        content: { text: '我在忙', autoReply: true },
      },
    ]);
    for (const peer of ['blocked-by-applicant', 'blocked-applicant']) {
      await conversation(peer, [
        { from: peer, height: 1 },
        { from: 'applicant', height: 2 },
      ]);
    }
    await block('applicant', 'blocked-by-applicant');
    await block('blocked-applicant', 'applicant');

    expect(await eligible({})).toEqual([]);
    expect(await chatted('applicant', 'blocked-applicant')).toBe(false);
  });

  it('returns a member once when they are both a friend and a chat partner', async () => {
    await member('both', '2026-01-01 00:00:00');
    await friend('applicant', 'both');
    await friend('both', 'applicant');
    await conversation('both', [
      { from: 'both', height: 1 },
      { from: 'applicant', height: 2 },
    ]);

    expect(await eligible({})).toEqual(['both']);
  });

  it('intersects active members with accepted friends in either direction, by join order', async () => {
    await member('late-friend', '2026-03-01 00:00:00');
    await member('early-friend', '2026-01-01 00:00:00');
    await member('reverse-friend', '2026-02-01 00:00:00');
    await member('stranger', '2026-01-15 00:00:00');
    await friend('applicant', 'late-friend');
    await friend('applicant', 'early-friend');
    // 好友行里申请人在 friendID 一侧。
    await friend('reverse-friend', 'applicant');
    // 好友但不在这个圈里。
    await friend('applicant', 'outside-friend');

    expect(await eligible({})).toEqual([
      'early-friend',
      'reverse-friend',
      'late-friend',
    ]);
  });

  it('drops non-accepted friendships, inactive or other-circle members, and the excluded ids', async () => {
    await member('pending-friend', '2026-01-01 00:00:00');
    await member('withdrawn-friend', '2026-01-02 00:00:00');
    await member('inactive-member', '2026-01-03 00:00:00', {
      status: 'PENDING',
    });
    await member('other-circle', '2026-01-04 00:00:00', {
      circleID: 'circle-2',
    });
    await member('seated-verifier', '2026-01-05 00:00:00');
    await member('rejected-verifier', '2026-01-06 00:00:00');
    await member('applicant', '2026-01-07 00:00:00');
    await member('ok', '2026-01-08 00:00:00');
    await friend('applicant', 'pending-friend', 'PENDING');
    await friend('withdrawn-friend', 'applicant', 'WITHDRAWN');
    for (const id of [
      'inactive-member',
      'other-circle',
      'seated-verifier',
      'rejected-verifier',
      'ok',
    ]) {
      await friend('applicant', id);
    }
    // 自己和自己的脏数据行：CASE 取回申请人自己，被排除名单挡掉。
    await friend('applicant', 'applicant');

    expect(
      await eligible({
        excludedUserIds: ['seated-verifier', 'rejected-verifier', 'applicant'],
      }),
    ).toEqual(['ok']);
  });

  it('returns each member once even when the friendship is stored twice', async () => {
    await member('dup-friend', '2026-01-01 00:00:00');
    await friend('applicant', 'dup-friend');
    await friend('dup-friend', 'applicant');
    await friend('applicant', 'dup-friend');

    expect(await eligible({})).toEqual(['dup-friend']);
  });

  it('narrows from the applicant’s friendships instead of pulling every member', async () => {
    // 3000 人的大圈，申请人只有几个好友在里面。
    await s.db.query(`
      INSERT INTO "CircleMember" (id, "userID", "circleID", status, "createdAt")
      SELECT 'm-' || g, 'user-' || g, 'circle-1', 'ACTIVE', TIMESTAMP '2026-01-01' + (g || ' minutes')::interval
      FROM generate_series(1, 3000) g;
      INSERT INTO "CircleMember" (id, "userID", "circleID", status, "createdAt")
      SELECT 'o-' || g, 'user-' || g, 'circle-' || (g % 40 + 2), 'ACTIVE', TIMESTAMP '2026-01-01'
      FROM generate_series(1, 3000) g;
      INSERT INTO "Friend" (id, "userID", "friendID", state)
      SELECT 'fx-' || g, 'user-' || g, 'user-' || (g + 1), 'ACCEPTED'
      FROM generate_series(1, 5000) g;
      INSERT INTO "Friend" (id, "userID", "friendID", state) VALUES
        ('fa-1', 'applicant', 'user-10', 'ACCEPTED'),
        ('fa-2', 'user-20', 'applicant', 'ACCEPTED');
      ANALYZE "CircleMember"; ANALYZE "Friend";
    `);

    const q = eligibleVerifierIdsQuery({
      circleId: 'circle-1',
      callerId: 'applicant',
      excludedUserIds: ['applicant'],
    });
    const plan = await explainPlan(s.db, q.text, q.values);
    // 好友一侧两个方向各走一条成对索引；成员一侧不整表扫描。
    expect(plan).toContain('Friend_userID_friendID_idx');
    expect(plan).toContain('Friend_friendID_userID_idx');
    expect(plan).not.toMatch(
      /"Node Type":"Seq Scan"[^}]*"Relation Name":"CircleMember"/,
    );
    expect(await eligible({})).toEqual(['user-10', 'user-20']);
  });
});
