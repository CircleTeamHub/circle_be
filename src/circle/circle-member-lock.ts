import { Injectable } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';

const CIRCLE_MEMBER_LOCK_PREFIX = 'circle-member:';
const CIRCLE_POLICY_LOCK_PREFIX = 'circle-policy:';

@Injectable()
export class CircleMemberLockService {
  constructor(private readonly membershipPolicy: MembershipPolicyService) {}

  async lock(
    tx: Prisma.TransactionClient,
    circleID: string,
    requestedUserIDs: readonly string[],
  ): Promise<void> {
    const userIDs = [...new Set(requestedUserIDs)]
      // Code-unit ordering is stable across hosts and matches membership locks.
      // eslint-disable-next-line sonarjs/no-alphabetical-sort
      .sort();

    await this.membershipPolicy.lockUsers(tx, userIDs);
    if (userIDs.length === 0) return;

    const pairKeys = userIDs.map(
      (userID) => `${CIRCLE_MEMBER_LOCK_PREFIX}${circleID}:${userID}`,
    );
    await tx.$executeRaw(
      Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(keys.lock_key, 0))
        FROM unnest(ARRAY[${Prisma.join(pairKeys)}]::text[]) AS keys(lock_key)
      `,
    );
  }

  /**
   * 招新策略锁(整个圈子一把)。
   *
   * 策略的读与写必须串行:成员锁是按 (circle, user) 对取的,建单方拿的是
   * 申请人/邀请人那两把,PATCH /circle/:id 拿的是操作者/圈主那两把,两组不
   * 相交。于是「读到旧策略的建单」可以在「收严已经返回成功」之后才提交 ——
   * 圈主看到 200、以为闸已经落下,却还会再放进来一个人。
   *
   * 一律在 lock()(成员锁)之后取,保证全仓获锁顺序一致。
   */
  async lockPolicy(
    tx: Prisma.TransactionClient,
    circleID: string,
  ): Promise<void> {
    const key = `${CIRCLE_POLICY_LOCK_PREFIX}${circleID}`;
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }
}
