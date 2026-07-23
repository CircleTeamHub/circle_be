import { Injectable } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';

export const MARKETING_ENTITLEMENT_FLOOR_LEVEL = 2 as const;

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
  ): Promise<MembershipProgramStatus> {
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
          hashtextextended('membership-program-enable', 0)
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
