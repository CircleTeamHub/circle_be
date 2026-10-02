import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * MinIO 在 2025-10 停止向 Docker Hub 发布镜像，随后 minio/minio 与 minio/mc 两个仓库
 * 被整个删掉，拉取直接报 `pull access denied`。部署配置曾迁移到 quay.io 的同一批标签。
 *
 * 这几个文件都要拉 MinIO：生产 compose（会随发布包分发）、
 * 备份镜像、两份备份演练脚本。任何一处退回 Docker Hub 的写法，都会在一台还没缓存过
 * 镜像的机器上拉不下来 —— 主干 CI 就是这样红的。
 */
const FILES_PULLING_MINIO = [
  'docker-compose.yml',
  'docker-compose.prod.yml',
  'docker/backup/Dockerfile',
  'scripts/test-minio-backup.sh',
  'scripts/test-backup-restore.sh',
];

/** 只有本地开发 compose 允许跟随最新版，其余都要锁定到具体发布。 */
const MAY_FLOAT = new Set(['docker-compose.yml']);

describe('MinIO image source', () => {
  it('builds the signed-upload fixture from pinned upstream source without a published MinIO image', () => {
    const script = readFileSync(
      join(process.cwd(), 'scripts/test-minio-integration.sh'),
      'utf8',
    );
    const dockerfile = readFileSync(
      join(process.cwd(), 'docker/minio-test/Dockerfile'),
      'utf8',
    );
    expect(script).toContain(
      'docker build --tag circle-be-minio-test:local docker/minio-test',
    );
    expect(script).toContain('circle-be-minio-test:local server /data');
    expect(script).not.toMatch(/(?:quay\.io\/)?minio\/(?:minio|mc):/);
    expect(dockerfile).toContain('FROM golang:1.26.7-alpine AS build');
    expect(dockerfile).toContain(
      'go install github.com/minio/minio@07c3a429bfed433e49018cb0f78a52145d4bedeb',
    );
  });

  it.each(FILES_PULLING_MINIO)(
    '%s pulls MinIO from quay.io instead of the removed Docker Hub repositories',
    (file) => {
      const content = readFileSync(join(process.cwd(), file), 'utf8');
      const references = content.match(/\S*minio\/(?:minio|mc):\S+/g) ?? [];

      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        expect(reference).toMatch(/^quay\.io\/minio\/(?:minio|mc):/);
        if (!MAY_FLOAT.has(file)) {
          expect(reference).toMatch(/:RELEASE\.\d{4}-\d{2}-\d{2}T/);
        }
      }
    },
  );
});
