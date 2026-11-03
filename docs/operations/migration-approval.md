# Approve a database contract for automatic releases

The historical `deploy/REQUIRES_IRREVERSIBLE_MIGRATION` marker may remain after
its migrations have been applied. An administrator can approve the exact
database contract so ordinary application updates can deploy without downtime
or irreversible-migration confirmations. Approval is specific to this server's
database history. It does not change the schema compatibility floor.

Before approving, audit the target commit and the actual database:

1. Compare every applied `_prisma_migrations` record with the checked-out
   migration history and its SHA-256 SQL checksum. Investigate missing, edited,
   failed, rolled-back, or unfinished records; resolve drift before proceeding.
2. List every pending migration and review its SQL, ordering, locks, transaction
   behavior, and effects on the currently serving binary. Confirm historical
   destructive migrations are already applied. Pending SQL must be safe for the
   ordinary blue/green migration window; otherwise perform an explicitly
   confirmed downtime release first, then audit again.
3. Review `prisma/schema.prisma`, `deploy/SCHEMA_COMPATIBILITY`, and the historical
   marker, and record the reviewed commit, applied checksums, pending SQL,
   reviewer, and backup/recovery evidence in the operational change record.
4. On the exact audited checkout, compute:

   ```bash
   bash deploy/migration-baseline.sh digest .
   ```

   This prints exactly one lowercase 64-character SHA-256 digest. It covers
   source-relative file names and exact contents of every regular file under
   `prisma/migrations`, the Prisma schema, schema compatibility metadata, and
   marker presence/content. Application code and operational tooling are outside
   this contract. Symlinks, missing required paths, and empty migration trees
   fail closed. Compute from Linux checkout/archive bytes used for deployment;
   CRLF conversion changes the digest.
5. As a host administrator, install that literal reviewed value outside the
   deployment checkout:

   ```bash
   set -euo pipefail
   approved_digest='<paste the reviewed 64-character lowercase digest>'
   [[ "$approved_digest" =~ ^[0-9a-f]{64}$ ]]
   sudo install -d -o root -g root -m 0755 /etc/circle-release
   approval_file="$(mktemp)"
   printf '%s\n' "$approved_digest" > "$approval_file"
   sudo install -o root -g root -m 0644 "$approval_file" \
     /etc/circle-release/migration-baseline.sha256
   rm -f -- "$approval_file"
   ```

   `/etc`, `/etc/circle-release`, and the approval file must be root-owned,
   non-symlinks, and not writable by group/others. The file must also be
   non-writable by the deployment user, including through ACLs. Its contents must
   be precisely the digest, with zero or one trailing LF. The production script
   uses this fixed path; repository content and manifests cannot override it.
6. Set the repository Actions variable `AUTO_RELEASE_MIGRATIONS_SHA256` to that
   exact digest, without whitespace or a newline. Keep `AUTO_RELEASE=off` during
   setup if necessary, and enable automatic releases only after both approvals
   are installed and verified.

When configured, Auto Release rejects malformed or mismatched approval values
before tagging or dispatching. Release checks the target tag's contract before
the manual rollback tooling overlay; overlaying current deployment scripts never
replaces the target schema, migrations, compatibility level, or marker. The
server independently checks the staged tree before migration or traffic changes.
A matching approval permits the historical marker with ordinary dispatch.

Every database-contract change requires a fresh manual audit and approval of
both locations, including marker removal. Never update approvals automatically
from CI or approve an unreviewed pending migration. A mismatch without a marker
still blocks ordinary releases. With no approval configured, legacy unmarked
releases remain supported and marked releases require the existing explicit
`downtime=true` plus `irreversible_migration=true` workflow dispatch. Those two
explicit confirmations remain the controlled path for a changed destructive
contract; they do not update either approval automatically. The existing schema
floor still rejects incompatible old binaries.
