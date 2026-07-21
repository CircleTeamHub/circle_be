# Backups & Restore

Off-host, encrypted, continuous backup for every stateful store, plus the
restore drill that proves it works.

- **Enable:** [Turning it on](#turning-it-on)
- **Break glass — production is gone:** [Disaster recovery](#disaster-recovery)
- **Prove it works:** [The restore drill](#the-restore-drill)

---

## The risk this mitigates

`pg_data` and `minio_data` are docker volumes on **one box**. OpenIM's Mongo —
which holds **every chat message** — is a volume on that same box, in a separate
compose stack. One `docker compose down -v`, one bad disk, one compromised root,
and the business data *and* the entire chat history are gone at the same instant,
with no second copy anywhere.

Before this, the only thing resembling a backup was the `pg_dump` in
`deploy/release-deploy.sh` (~line 271), which writes to `$HOME/circle_be_backups`
**on the same host**. That is a migration-rollback aid, not a backup: it dies with
the disk, it only runs at deploy time, and it does not cover MinIO or Mongo. It is
still there and still useful for its actual job — this system does not replace it.

Off-host is the entire point. Everything below follows from that.

---

## What is backed up

| Store | Contents | Method | Destination prefix |
|---|---|---|---|
| **Postgres** (`pg_data`) | All business data | pgBackRest: weekly full + daily differential + **continuous WAL archiving** | `/pgbackrest` |
| **MinIO** (`minio_data`) | Avatars, chat attachments, note media | `mc mirror` every 15 min | `/minio/<bucket>` |
| **OpenIM Mongo** | **Every chat message** | `mongodump` hourly, age-encrypted | `/mongo` |

OpenIM runs as a **separate compose stack** (`openim-docker`, per
`docker-compose.prod.yml:5` and `DEPLOY.md` phase 5). It is a third-party upstream
checkout and **nothing in it is modified**. The backup container joins its docker
network from our side and reads with credentials the operator supplies. That is
the whole integration.

### What is deliberately NOT backed up

**Do not add these "just in case".** Both are reconstructible, and backing them
up would mean copying secrets around for no recovery benefit.

- **`redis_data`** — cache, WS backplane, and rate-limit counters only. Every
  consumer degrades gracefully: production defaults to degraded startup when
  Redis is unavailable (`REDIS_REQUIRED=false`, see `.env.example`). Restoring a
  stale cache is at best useless and at worst actively wrong — it would resurrect
  expired rate-limit windows and dead WS routing entries. Redis rebuilds itself
  from Postgres on first use.
- **`caddy_data`** — TLS certificates and ACME account keys. Caddy re-issues
  automatically from Let's Encrypt on startup. Restoring these buys nothing and
  copies private keys to a third location. The only cost of not having them is a
  few seconds of ACME issuance on first boot, and LE rate limits are per-domain
  and generous enough that this has never been the binding constraint.

Also not backed up: the app's own `.env` / `.env.production`. Those are secrets,
not data. Keep them in a password manager. `deploy/gen-env.sh` regenerates the
structure; the values must be restored by a human.

---

## RPO and RTO

Target set by the owner: **RPO ≈ 15 min, RTO ≈ 1 hour.**

| Store | RPO achieved | How we know |
|---|---|---|
| **Postgres** | **≈ 60–90 s** (beats target) | `archive_timeout=60` forces a WAL segment switch every 60s even when the segment is not full; pgBackRest pushes it immediately. `scripts/test-backup-restore.sh` writes rows, waits out `archive_timeout` with **no** manual `pg_switch_wal()`, destroys PGDATA, restores, and asserts those exact rows come back. |
| **MinIO objects** | **≈ 15 min** (meets target) | `mc mirror` runs every 15 min. Worst case a file uploaded just after a run is lost if the box dies before the next one. |
| **OpenIM chat history** | **≈ 1 hour** ❗ **misses the 15-min target** | Hourly `mongodump`. See below — this is a real, documented gap, not an oversight. |

**RTO ≈ 1 hour** is met for Postgres by construction: a differential restore
fetches the last full + **one** differential (not a week of incrementals), then
replays at most ~24h of WAL. This is why the daily job is `pg-diff` and not
`pg-incr` — a deliberate deviation from "weekly full + daily incremental",
trading a little storage for a much shorter restore. Actual RTO is dominated by
download bandwidth from the destination, so **size the destination for restore
speed, not just cost** (R2 has zero egress fees, which matters here).

### RPO gap: chat history

**Chat-history RPO equals the mongodump interval, and cannot be made continuous
without changing the OpenIM stack.**

OpenIM's mongod is started as a **standalone** — verified against the running
container, its command is `mongod --wiredTigerCacheSizeGB N --auth` with **no
`--replSet`**. A standalone mongod has **no oplog**, and without an oplog:

- `mongodump --oplog` does not work,
- there is no point-in-time recovery,
- there is nothing to tail for continuous capture.

So the only lever is dump frequency, and each dump is a **full** dump. The default
is hourly (`BACKUP_CRON_MONGO=0 * * * *`) as the balance between RPO and cost;
lower it if the dump is small and fast enough, and watch the destination bill.

Closing this gap properly requires converting OpenIM's Mongo to a single-node
replica set (`--replSet`) to get an oplog. That is a change to the third-party
`openim-docker` stack, which is **explicitly out of scope** here. It is the right
follow-up if a 15-min RPO on chat history is a hard requirement — track it
separately.

**Trade-off you are accepting elsewhere:** if `archive_command` starts failing
(destination down, credentials rotated), WAL accumulates in `pg_wal` until the
disk fills and Postgres stops accepting writes. That is deliberate.
`archive-push-queue-max` would instead let pgBackRest **silently discard** WAL to
save the disk — trading a loud outage for a silent, undetectable hole in your
backup chain, discovered only at restore time. For a system whose entire purpose
is being trustworthy at restore time, failing loudly is correct.
`deploy/backup/check.sh` runs hourly to surface this long before the disk fills.

---

## What the operator must provision

**None of this can be created from the repo.** Do all of it before enabling.

### 1. A backup bucket at a different provider

Not another bucket on the same MinIO. Not another volume on the same box. A
different provider/account — that is what makes it off-host.

Cloudflare R2 or AWS S3 both work. `BACKUP_S3_ENDPOINT` **must be `https://`** —
pgBackRest has no plaintext option for S3 repos at all (it has a certificate
*verification* toggle, not a TLS on/off switch), and off-host backups must not
travel in the clear regardless.

### 2. Separate, least-privilege credentials

**The backup destination must not be reachable with the app's MinIO/S3
credentials.** If the app is compromised, the attacker must not be able to reach
the backups — deleting the backups first is the standard ransomware playbook.
Create dedicated credentials scoped to the backup bucket only.

**AWS S3** — enable **Versioning** and **Object Lock** on the bucket, then attach
this policy to a dedicated IAM user. It can write and read, and its deletes only
ever create delete markers; it cannot destroy a version, and it cannot turn off
the protections that make that true:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadWriteBackupObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": "arn:aws:s3:::YOUR-BACKUP-BUCKET/*"
    },
    {
      "Sid": "ListOwnBucketOnly",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::YOUR-BACKUP-BUCKET"
    },
    {
      "Sid": "NeverDestroyHistoryOrDisableProtections",
      "Effect": "Deny",
      "Action": [
        "s3:DeleteObjectVersion",
        "s3:PutBucketVersioning",
        "s3:PutLifecycleConfiguration",
        "s3:PutBucketPolicy",
        "s3:PutObjectLockConfiguration",
        "s3:BypassGovernanceRetention"
      ],
      "Resource": ["arn:aws:s3:::YOUR-BACKUP-BUCKET", "arn:aws:s3:::YOUR-BACKUP-BUCKET/*"]
    }
  ]
}
```

The `Deny` block is the whole point: with versioning on, `s3:DeleteObject` only
writes a delete marker, and the real bytes survive as a noncurrent version that
this credential provably cannot touch.

**Cloudflare R2** — R2 does **not** implement S3 object versioning at all
(`PutBucketVersioning` and `PutObjectLockConfiguration` are on Cloudflare's
unsupported-operations list), so the policy above has no R2 equivalent and
"versioning protects us" is simply **false on R2**. Use **R2 Bucket Locks**
instead:

```bash
# Retention MUST be shorter than BACKUP_PG_RETENTION_FULL (see the warning below)
wrangler r2 bucket lock add YOUR-BACKUP-BUCKET \
  --name pgbackrest-immutable --prefix pgbackrest/ --retention-days 30
wrangler r2 bucket lock add YOUR-BACKUP-BUCKET \
  --name mongo-immutable --prefix mongo/ --retention-days 30
```

Then create a **scoped API token** (R2 → Manage API Tokens) with *Object
Read & Write* on **this bucket only**. Note that Bucket Locks are configurable
only via the dashboard/Wrangler/Cloudflare API — **not** the S3 API — so a
compromised S3 credential cannot remove them, which is exactly what we want.

> ⚠️ **The lock window must be SHORTER than the pgBackRest retention.**
> `pgbackrest expire` deletes backup sets older than `BACKUP_PG_RETENTION_FULL`
> (default 8 fulls ≈ 8 weeks). If the immutability window is *longer* than that,
> expire tries to delete still-locked objects and fails **forever**, and the repo
> grows without bound. 30-day lock vs 8-week retention is safe: expire only ever
> touches objects that unlocked weeks ago. The ransomware protection window is
> the lock duration — 30 days during which nothing can delete a backup, valid
> credentials or not.

> ⚠️ **Never put a lifecycle expiry rule on the `pgbackrest/` prefix.** pgBackRest
> maintains its own manifest; lifecycle deleting objects behind its back silently
> corrupts the backup set, and you find out at restore time. Retention there is
> `pgbackrest expire`'s job **only**. Lifecycle rules on `mongo/` are fine (those
> are independent files), and `minio/` never deletes anything by design.

### 3. A read-only MinIO user for the source

The backup only ever *reads* the app's bucket. Do not reuse `MINIO_ROOT_USER`.

```bash
# via mc, against the app's MinIO (console is on 127.0.0.1:9001 through an SSH tunnel)
mc admin user add local circle-backup "$(openssl rand -hex 24)"
cat > /tmp/readonly.json <<'EOF'
{ "Version": "2012-10-17", "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:ListBucket"],
    "Resource": ["arn:aws:s3:::circle", "arn:aws:s3:::circle/*"] }] }
EOF
mc admin policy create local circle-backup-ro /tmp/readonly.json
mc admin policy attach local circle-backup-ro --user circle-backup
```

Put that access key / secret in `BACKUP_MINIO_ACCESS_KEY` / `BACKUP_MINIO_SECRET_KEY`.

### 4. An age keypair for the Mongo dumps

**Generate this on your workstation, never on the server.**

```bash
age-keygen -o circle-backup-age.key      # keep OFF the server, in a password manager
grep 'public key' circle-backup-age.key  # -> age1... goes in BACKUP_AGE_RECIPIENT
```

Only the **public** key goes on the server. The dumps are encrypted to it, so a
full compromise of the box cannot decrypt any existing chat-history backup. The
private key is needed only at restore time (`restore-mongo.sh --identity`).

> The Postgres repo does **not** have this property: pgBackRest encryption is
> symmetric, because it must read the repo to build differentials. The server
> therefore holds `BACKUP_PG_CIPHER_PASS` and can decrypt its own Postgres repo.
> That is inherent to pgBackRest, not an oversight. The object mirror relies on
> the destination's server-side encryption at rest rather than client-side
> encryption, because `mc mirror` copies bytes as-is — those are the same media
> files the app already serves.

### 5. `.env.backup`

```bash
cp .env.backup.example .env.backup && chmod 600 .env.backup
```

Fill in every value. There are no defaults for credentials, deliberately: a
default credential is a published credential. (The `openim-docker` stack next
door ships `openIM123` as the default for four separate secrets. If your OpenIM
Mongo still uses it, **change it there before** pointing this at it — otherwise
your chat-history backup is protected by a password published in a public repo.)

**`BACKUP_PG_CIPHER_PASS` is not recoverable.** Lose it and every Postgres backup
is permanently unreadable. Put it in a password manager before you continue.

---

## Turning it on

Backups are an **opt-in overlay**. The base stack is unchanged without it.

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.backup.yml up -d
```

To include the chat-history backup, add the profile to `.env`:

```
COMPOSE_PROFILES=bundled-redis,openim-backup
```

> ⚠️ **Make the overlay sticky.** Enabling archiving means postgres is recreated
> from the overlay's definition. A later bare
> `docker compose -f docker-compose.prod.yml up -d` recreates it from the *base*
> definition and **silently turns WAL archiving back off** — no error, and the
> next restore quietly loses everything since that moment. Add this to `.env` so
> every bare `docker compose` command in the project directory keeps the overlay:
>
> ```
> COMPOSE_FILE=docker-compose.prod.yml:docker-compose.backup.yml
> ```
>
> This is belt-and-braces: `deploy/backup/check.sh` runs hourly and fails loudly
> if archiving has stopped, precisely because this footgun exists.
> (`deploy/release-deploy.sh` passes explicit `-f` flags and uses `--no-deps`, so
> it does not touch postgres and is unaffected.)

**Enabling archiving restarts Postgres.** `archive_mode` is a postmaster-level
setting; it cannot be turned on without a restart. Data is safe (the volume
persists) but there is a short interruption — do it in a maintenance window.

Verify:

```bash
docker compose ... exec postgres psql -U circle -d circle -c 'SHOW archive_mode'   # -> on
docker compose ... run --rm backup run check                                        # -> all checks passed
docker compose ... logs -f backup
```

Run jobs by hand at any time:

```bash
docker compose ... run --rm backup run pg-full   # full backup now
docker compose ... run --rm backup run minio     # mirror objects now
docker compose ... run --rm backup run mongo     # dump chat history now
docker compose ... run --rm backup run drill     # restore drill
```

### What the hourly check does and does not cover

`deploy/backup/check.sh` is the only thing that runs unattended, so it is worth
knowing exactly what a passing check proves.

| Checked hourly | How | Catches |
|---|---|---|
| Postgres WAL archiving | `pgbackrest check` forces a segment switch and confirms it landed | overlay dropped (`archive_mode` back to off), expired S3 credentials |
| Postgres backup freshness | newest `stop` timestamp in `pgbackrest info`, fails over 48h | a stalled or crash-looping schedule |
| Destination reachability | `mc ls` on the destination bucket | rotated/revoked `BACKUP_S3_*` |
| **Chat-history freshness** | newest object under `mongo/`, fails over `BACKUP_CHECK_MONGO_MAX_AGE_H` (3h) | the mongo dump failing every run — see below |
| **Source MinIO readability** | `mc ls` on the source bucket | rotated `BACKUP_MINIO_*`, which breaks every mirror run |

**Not checked, by design:** object-mirror freshness. The mirror only creates
objects when users upload, so "nothing new this hour" is indistinguishable from
a broken mirror. The source-credential probe above is the closest proxy; the
drill is what actually proves the objects are there.

The chat-history check is deliberately conditional on `mongo/` being non-empty:
`backup_mongo` is profile-gated and legitimately absent until OpenIM is deployed
(DEPLOY.md stage 5), and a job that was never enabled must not raise an alarm.
Once a single dump exists, the schedule is assumed live and staleness fails.

---

## The restore drill

**An untested backup is not a backup.** This is the only thing that proves the
off-host copy, the encryption, and the credentials all actually work together.

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.backup.yml \
  run --rm backup run drill
```

It is **non-destructive** and safe against production. It:

1. reads exact per-table row counts from the **live** database,
2. restores the latest backup from the off-host repo into a **scratch** PGDATA,
3. starts a throwaway postmaster on port 5433 and replays WAL,
4. compares exact row counts table by table,
5. exits non-zero if the restore is not usable.

The scratch cluster is always started with `archive_mode=off`. Without that it
would push its own WAL into the repo it was just restored from, fork the
timeline, and corrupt the live backup set. Every restore path here does this.

**It needs free disk roughly equal to the database size**, in the
`backup_scratch` volume — the drill restores a full second copy. It is emptied
when the drill exits. (That volume is deliberately not tmpfs: a RAM-backed copy
of production is an OOM waiting to happen.)

Reading the output: on a busy database `live > restored` is expected drift
(writes landed while the drill ran). `restored > live`, a missing table, or a
table that comes back **empty** when live has rows are all hard failures.

**Run it monthly, and after any change to backup config or credentials.** Put it
in a calendar; a drill nobody runs is the same as no drill.

### Full round-trip proof (destructive, throwaway stack)

`scripts/test-backup-restore.sh` is the end-to-end proof, and it exercises the
**real** artifacts — the same compose files, Dockerfiles, and scripts production
uses — against a throwaway project and a local TLS MinIO standing in for R2/S3.
It backs up, writes more rows, **destroys PGDATA entirely**, restores, and
asserts exact row counts, including rows that only continuous WAL archiving could
have saved. Nothing outside its own `circle-backup-drill-$$` project is touched.

```bash
scripts/test-backup-restore.sh
```

---

## Disaster recovery

### Postgres

```bash
# 1. Stop the app and postgres. Restore refuses to run against a live postmaster.
docker compose ... stop circle_be postgres

# 2. See what you have.
docker compose ... run --rm --no-deps backup pgbackrest --stanza=circle info

# 3. Restore in place. Omit --time to recover to the latest archived WAL.
docker compose ... run --rm --no-deps backup \
  /opt/backup/restore-postgres.sh --to /var/lib/postgresql/data

#    ...or point-in-time, e.g. to just before a bad migration:
docker compose ... run --rm --no-deps backup \
  /opt/backup/restore-postgres.sh --to /var/lib/postgresql/data \
  --time "2026-07-17 08:30:00+00"

# 4. Start it. Postgres replays WAL from the repo and promotes.
docker compose ... up -d postgres
docker compose ... up -d circle_be
```

On a **brand-new host** the repo is the only input needed: install docker, clone
the repo, restore `.env` / `.env.production` / `.env.backup` from your password
manager, then run the above. Nothing about recovery depends on the dead machine.

### Objects

```bash
docker compose ... run --rm --no-deps backup /opt/backup/restore-minio.sh --dry-run
docker compose ... run --rm --no-deps backup /opt/backup/restore-minio.sh
```

Needs MinIO credentials that can **write** — the read-only backup user cannot
restore. Use the root credentials for this, once.

### Chat history

Needs the age **private** key, which is not on the server. Mount it read-only for
the restore and take it away afterwards:

```bash
docker compose ... run --rm --no-deps \
  -v /path/to/circle-backup-age.key:/key:ro backup \
  /opt/backup/restore-mongo.sh --identity /key
```

`--key` selects a specific dump (default: the most recent). `--drop` replaces
collections instead of merging into them.

---

## Design notes / known limitations

- **`mc mirror`, not MinIO bucket replication.** MinIO's built-in server-side
  replication only works **MinIO → MinIO** ("both the source and destination
  deployments must run MinIO"), and its own docs redirect arbitrary
  S3-compatible targets to `mc mirror`. It also requires versioning on both
  buckets, which R2 does not have. Replication to R2/S3 is therefore not
  available, so we use MinIO's own client on a schedule. This is a deviation from
  the original plan, forced by the tooling.
- **`mc mirror --watch` is not used.** Its resume-after-outage behaviour has
  long-standing upstream bugs (minio/mc#4883, #2105, #1560) and would leave
  silent gaps exactly when it matters. Scheduled runs re-reconcile the whole key
  space, so a run that dies is repaired by the next one.
- **The object mirror is append-only.** No `--remove`, no `--overwrite`. Upload
  keys are `<folder>/<userId>/<uuid>.<ext>` (`src/upload/upload.service.ts`) —
  write-once and never reused — so neither flag is needed. An attacker holding
  the app's MinIO credentials can delete or corrupt the live bucket and **none of
  it propagates to the backup**. This is what replaces the object-versioning
  protection R2 cannot provide.
- **Consequence: the object backup only grows, and deletes never propagate.**
  If a user exercises a right-to-erasure request, their media stays in the backup
  prefix until you remove it explicitly. Standard practice is to honour deletion
  in backups via a retention window; decide the retention you want and add a
  lifecycle rule on `minio/` accordingly. This is a policy decision, not a
  technical one, and it is not made for you here.
- **The three stores are not mutually consistent.** Postgres, objects, and chat
  history are captured on independent schedules; a restore can land a Postgres
  row referencing an object that the mirror had not copied yet. Given the data
  model (objects are immutable and referenced by UUID) the failure mode is a
  broken media link, not corruption. A cross-store consistent snapshot would need
  coordinated quiescing and is not worth it here.
- **A failed Mongo dump deletes its own object.** `mongodump | age | mc pipe` is
  not safe on its own: if `mongodump` dies, `age` still sees a clean EOF and
  emits a *structurally valid* archive wrapping zero bytes, which `mc pipe`
  uploads. `pipefail` fails the run, but the object is already in the bucket —
  and `restore-mongo.sh` without `--key` picks the **newest** object under
  `mongo/`, which is exactly that one. So the upload runs under `if !`, and any
  failure (or an object below `BACKUP_MONGO_MIN_BYTES`) is deleted again before
  the script exits non-zero. If the delete itself fails — an object-lock window
  can legitimately block it — the log says so explicitly and the object must be
  removed by hand before the next restore.
- **Single repo.** One destination bucket, one provider. If that provider loses
  the bucket, there is no third copy. A second `repo2-*` destination is a
  supported pgBackRest configuration if that risk ever matters.
