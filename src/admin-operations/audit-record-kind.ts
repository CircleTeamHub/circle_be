import { Prisma } from 'src/generated/prisma';

// Keep the two views disjoint. Failures are recorded using these action suffixes.
export const FAILED_AUDIT_WHERE = {
  OR: [
    { action: { endsWith: '.failed' } },
    { action: { endsWith: '_FAILED' } },
  ],
} satisfies Prisma.AdminAuditLogWhereInput;
