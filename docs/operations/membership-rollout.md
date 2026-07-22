# Membership Contract Rollout

The membership migration changes accepted database values and is not compatible
with old writers. Deploy it only in a coordinated maintenance window.

## Preconditions

1. Confirm the release commit contains
   `deploy/REQUIRES_IRREVERSIBLE_MIGRATION` and migration
   `20260722000000_membership_permissions`.
2. Stop direct database scripts and scheduled/manual jobs that can write users or
   circle membership restrictions.
3. Confirm the latest CI and release-contract tests passed for the tagged commit.
4. Confirm PostgreSQL has enough space for `pg_dump` and keep a database operator
   available until verification completes.
5. Announce maintenance. Do not use the tag-push path: the marker intentionally
   blocks it.

## Deployment

Run Actions > Release > Run workflow for the existing tag with both inputs set:

- `downtime: true`
- `irreversible_migration: true`

The workflow checks both confirmations before SSH. The server then pulls the
immutable image, writes `~/circle_be_backups/circle-*-pre-<tag>.sql.gz`, stops the
old application color, and runs `prisma migrate deploy`.

Record the backup filename from the release log. Verify it is non-empty before
the migration step begins. Off-host upload remains an additional copy, not a
substitute for the local pre-migration backup.

## Verification

After the workflow succeeds, verify the new application is healthy and run:

```sql
SELECT COUNT(*) AS invalid_users
FROM "User"
WHERE "vipLevel" NOT BETWEEN 0 AND 4;

SELECT COUNT(*) AS invalid_circle_restrictions
FROM "Circle"
WHERE "joinVipRestriction" IS NOT NULL
  AND "joinVipRestriction" NOT BETWEEN 1 AND 4;

SELECT COUNT(*) AS invalid_post_restrictions
FROM "CirclePost"
WHERE ("vipRestriction" IS NOT NULL
       AND "vipRestriction" NOT BETWEEN 1 AND 4)
   OR ("signupVipRestriction" IS NOT NULL
       AND "signupVipRestriction" NOT BETWEEN 1 AND 4);

SELECT column_name
FROM information_schema.columns
WHERE table_name = 'User' AND column_name = 'vipExpiresAt';

SELECT to_regclass('public."MembershipGrant"') AS membership_grant,
       to_regclass('public."MembershipBenefitGrant"') AS benefit_grant;
```

All invalid counts must be zero, `vipExpiresAt` must be returned, and both table
names must be non-null. Also verify `/readyz`, the authenticated membership read,
one regular account, one active paid account, one expired account, and a legacy
level-5 account normalized to effective super membership.

## Failure Boundary

- If the migration command exits nonzero, the script probes the target database
  for all four membership check constraints. It restarts the old binary only when
  none exists, which proves the transactional migration is unapplied. All four
  constraints present means applied; a partial set, probe
  failure, or malformed output is ambiguous. Applied and ambiguous states remain
  in maintenance.
- After migration success: startup, health, Caddy validation/reload, active-color
  state, or smoke failure must leave the service in maintenance. The script will
  not restart the old binary because it can write values rejected by the new
  constraints.

For a post-migration failure, prefer a forward fix built on the membership
contract. To run an old binary, first stop all application writers, restore the
recorded pre-migration dump, verify the restored schema, and only then deploy the
old image. Restoring only the binary is prohibited.

The server persists the compatibility floor at
`~/circle_be/.release/minimum-schema-compatibility`, outside the rsynced tree.
After a full database restore, verify the four membership constraints are absent:

```sql
SELECT count(*)
FROM pg_constraint
WHERE conname IN (
  'User_vipLevel_check',
  'Circle_joinVipRestriction_check',
  'CirclePost_vipRestriction_check',
  'CirclePost_signupVipRestriction_check'
);
```

Only when that query returns `0`, explicitly clear the boundary before deploying
a pre-marker tag:

```bash
rm -f ~/circle_be/.release/minimum-schema-compatibility
```

## Marker Removal

Do not remove `deploy/REQUIRES_IRREVERSIBLE_MIGRATION` from the migration release.
A later release may remove it only after the membership release has successfully
deployed and production verification is complete. That later release returns to
the normal tag-push path if all of its own migrations are backward compatible.
