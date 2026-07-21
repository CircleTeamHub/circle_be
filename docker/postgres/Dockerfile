# Postgres 16 + pgBackRest.
#
# Why a custom image: pgBackRest's `archive_command` runs as a child process of
# the Postgres postmaster, so the pgbackrest binary MUST live in the same
# container as the server. There is no sidecar-only way to do continuous WAL
# archiving — that is what buys RPO ≈ minutes instead of ≈ 24h.
#
# This image is only used when docker-compose.backup.yml is layered on top of
# docker-compose.prod.yml. Without that overlay the stack keeps using the stock
# postgres:16-alpine image and archiving stays off. See docs/backups.md.
#
# pgbackrest here and in docker/backup/Dockerfile are both installed from the
# Alpine repos of the same base tag, so the repository format stays compatible
# between the archiving side (this image) and the backup/restore side.
FROM postgres:16-alpine

RUN apk add --no-cache pgbackrest bash

# pgBackRest writes logs and lock files as the postgres user. PGDATA and the
# socket dir already belong to postgres (uid 70) in the base image.
RUN mkdir -p /var/log/pgbackrest /var/spool/pgbackrest \
    && chown -R postgres:postgres /var/log/pgbackrest /var/spool/pgbackrest \
    && chmod 750 /var/log/pgbackrest /var/spool/pgbackrest

# The entrypoint shim exports BACKUP_* -> PGBACKREST_* before the postmaster
# starts, so that BOTH archive_command and the restore_command pgBackRest
# generates during recovery inherit the credentials. Baked in rather than
# bind-mounted so the archiving path cannot break because of a host path.
COPY deploy/backup/lib.sh deploy/backup/postgres-entrypoint.sh /opt/backup/
RUN chmod +x /opt/backup/postgres-entrypoint.sh

ENTRYPOINT ["/opt/backup/postgres-entrypoint.sh"]
CMD ["postgres"]
