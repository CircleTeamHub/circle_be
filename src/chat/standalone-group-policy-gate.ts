import type { Prisma } from 'src/generated/prisma';

/** 两个「按成员」的独立群策略:普通成员能否看他人资料 / 能否互加好友。 */
export type StandaloneGroupMemberPolicy =
  | 'membersCanViewProfiles'
  | 'membersCanAddFriends';

/** 判定只读这三张表;事务里传 tx,其余地方传 PrismaService 都行。 */
export type StandaloneGroupPolicyGateClient = Pick<
  Prisma.TransactionClient,
  'chatMember' | 'friend' | 'circleMember'
>;

/**
 * 「成员可查看他人资料 / 成员可添加好友」的服务端判定。
 *
 * 不信客户端自报的 viaConversationId(不传就等于没有开关),而是从双方的关系里推导:
 * 只有当 actor 与 target **仅仅**通过独立群聊(circleID 为 null 的 GROUP)认识,
 * 且他们共同所在的每一个独立群都关着这个开关、actor 又都不是那个群的群主/管理员时,
 * 才算被挡住。下面任一条成立就放行:
 * - 本人看本人;
 * - 已是好友(任一方向 ACCEPTED),或对方先发了好友申请给 actor(PENDING);
 * - 同在一个未删除圈子里且双方都是 ACTIVE 成员(圈子成员目录有自己的闸);
 * - 至少有一个共同独立群开着这个开关,或 actor 是其中某个群的群主/管理员
 *   (与带 viaConversationId 的快路径同一口径:管理者不受成员策略约束);
 * - 根本没有共同的独立群 —— 这次动作与任何群策略无关,按普通路径处理。
 *
 * 查询按「能最早退出」排:共同独立群是唯一的必要条件,先查它;绝大多数请求在
 * 这一步就以「无共同群」放行,好友/圈子那两次查询只在真有共同群时才跑。
 */
export async function isBlockedByStandaloneGroupPolicy(
  prisma: StandaloneGroupPolicyGateClient,
  actorId: string,
  targetId: string,
  policy: StandaloneGroupMemberPolicy,
): Promise<boolean> {
  if (actorId === targetId) return false;
  const sharedSeats = await prisma.chatMember.findMany({
    where: {
      userID: actorId,
      leftAt: null,
      conversation: {
        type: 'GROUP',
        circleID: null,
        members: { some: { userID: targetId, leftAt: null } },
      },
    },
    select: {
      role: true,
      conversation: {
        select: {
          ownerID: true,
          membersCanViewProfiles: true,
          membersCanAddFriends: true,
        },
      },
    },
  });
  if (sharedSeats.length === 0) return false;
  const permitted = sharedSeats.some(
    (seat) =>
      seat.conversation[policy] ||
      seat.conversation.ownerID === actorId ||
      seat.role === 'ADMIN',
  );
  if (permitted) return false;

  const relationship = await prisma.friend.findFirst({
    where: {
      OR: [
        { userID: actorId, friendID: targetId, state: 'ACCEPTED' },
        {
          userID: targetId,
          friendID: actorId,
          state: { in: ['ACCEPTED', 'PENDING'] },
        },
      ],
    },
    select: { id: true },
  });
  if (relationship) return false;

  const sharedCircle = await prisma.circleMember.findFirst({
    where: {
      userID: actorId,
      status: 'ACTIVE',
      circle: {
        deleted: false,
        members: { some: { userID: targetId, status: 'ACTIVE' } },
      },
    },
    select: { id: true },
  });
  return sharedCircle === null;
}
