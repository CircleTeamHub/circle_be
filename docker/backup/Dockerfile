# Backup toolbox — one image that can reach both stateful stores.
#
# Base is postgres:16-alpine on purpose:
#   * pgbackrest comes from the same Alpine repo as docker/postgres/Dockerfile,
#     so the repository format matches the archiving side. A version skew
#     between archive-push and backup/restore is a real way to end up with an
#     unreadable repo.
#   * psql / pg_dump ship with it, which the restore drill needs to count rows.
#
# Tools and why:
#   pgbackrest     Postgres full/incr backup + WAL archive to S3 (encrypted).
#   mc             MinIO's own client; mirrors the object bucket off-host.
FROM minio/mc:RELEASE.2025-08-13T08-35-41Z AS mc

FROM postgres:16-alpine

# mc is a static Go binary, so it runs on musl despite being built elsewhere.
# Pinned by the image tag above rather than curl'ing a release at build time.
COPY --from=mc /usr/bin/mc /usr/local/bin/mc

RUN apk add --no-cache \
      pgbackrest \
      bash \
      tzdata \
    && mkdir -p /var/log/pgbackrest /var/spool/pgbackrest /var/log/circle-backup \
    && chown -R postgres:postgres /var/log/pgbackrest /var/spool/pgbackrest /var/log/circle-backup \
    && chmod 750 /var/log/pgbackrest /var/spool/pgbackrest /var/log/circle-backup

COPY deploy/backup/ /opt/backup/
RUN chmod +x /opt/backup/*.sh

ENV PATH="/opt/backup:${PATH}"
ENTRYPOINT ["/opt/backup/entrypoint.sh"]
CMD ["scheduler"]
