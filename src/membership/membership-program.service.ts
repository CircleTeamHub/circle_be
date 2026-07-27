import { Injectable } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';

export const MARKETING_ENTITLEMENT_FLOOR_LEVEL = 2 as const;

// Advisory-lock key shared by enablement (exclusive) and entitlement-writing
// transactions (shared). Both must hash the SAME string or they never contend.
const MEMBERSHIP_PROGRAM_LOCK_KEY = 'membership-program-enable';

/** Options for reading rollout status inside an entitlement-writing transaction. */
export type ProgramReadOptions = {
  /**
   * Take a SHARED advisory lock on the program key before reading, held until
   * the caller's transaction commits. This serializes the read+write against
   * {@link MembershipProgramService.enable} (which locks the same key
   * EXCLUSIVELY): enable waits for in-flight writes to commit, and a write that
   * begins while enable holds the lock blocks until enable commits and then
   * reads the fresh floor — closing the window where a quota write commits
   * under an obsolete entitlement. Outside a transaction the xact lock is a
   * no-op (autocommit), which is correct for pure reads.
   */
  lockForWrite?: boolean;
};

type ProgramStateRow = {
  enabledAt: Date | null;
  enabledByUserId: string | null;
};

export type MembershipProgramDatabase = Pick<
  PrismaService,
  '$executeRaw' | '$queryRaw'
>;

export type MembershipProgramStatus = {
  enabled: boolean;
  enabledAt: Date | null;
  enabledByUserId: string | null;
  entitlementFloorLevel: 0 | typeof MARKETING_ENTITLEMENT_FLOOR_LEVEL;
};

@Injectable()
export class MembershipProgramService {
  constructor(private readonly prisma: PrismaService) {}

  async getStatus(
    db: MembershipProgramDatabase = this.prisma,
    options: ProgramReadOptions = {},
  ): Promise<MembershipProgramStatus> {
    if (options.lockForWrite) {
      await db.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock_shared(
          hashtextextended(${MEMBERSHIP_PROGRAM_LOCK_KEY}, 0)
        )
      `);
    }
    const rows = await db.$queryRaw<ProgramStateRow[]>(Prisma.sql`
      SELECT "enabledAt", "enabledByUserId"
      FROM "MembershipProgramState"
      WHERE id = 1
      LIMIT 1
    `);
    return this.toStatus(rows[0]);
  }

  async enable(operatorUserId: string): Promise<{
    replayed: boolean;
    status: MembershipProgramStatus;
  }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${MEMBERSHIP_PROGRAM_LOCK_KEY}, 0)
        )
      `);

      const existing = await this.getStatus(tx as MembershipProgramDatabase);
      if (existing.enabled) {
        return { replayed: true, status: existing };
      }

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "MembershipProgramState" (
          id,
          "enabledAt",
          "enabledByUserId",
          "createdAt",
          "updatedAt"
        )
        VALUES (1, CURRENT_TIMESTAMP, ${operatorUserId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
          "enabledAt" = CURRENT_TIMESTAMP,
          "enabledByUserId" = ${operatorUserId},
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "MembershipProgramState"."enabledAt" IS NULL
      `);

      return {
        replayed: false,
        status: await this.getStatus(tx as MembershipProgramDatabase),
      };
    });
  }

  private toStatus(row?: ProgramStateRow): MembershipProgramStatus {
    const enabled = row?.enabledAt != null;
    return {
      enabled,
      enabledAt: row?.enabledAt ?? null,
      enabledByUserId: row?.enabledByUserId ?? null,
      entitlementFloorLevel: enabled ? 0 : MARKETING_ENTITLEMENT_FLOOR_LEVEL,
    };
  }
}
