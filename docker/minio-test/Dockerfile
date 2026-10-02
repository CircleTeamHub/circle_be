# Test-only replacement for the removed upstream community image. Keep the
# same MinIO release as the signed-upload fixture: RELEASE.2025-09-07T16-13-09Z.
FROM golang:1.26.7-alpine AS build
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/minio/minio@07c3a429bfed433e49018cb0f78a52145d4bedeb

FROM scratch
COPY --from=build /out/minio /minio
ENTRYPOINT ["/minio"]
