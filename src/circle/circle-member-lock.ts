import { Injectable } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';

const CIRCLE_MEMBER_LOCK_PREFIX = 'circle-member:';

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
}
