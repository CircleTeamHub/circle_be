import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

/** 会拉镜像的地方：compose、Dockerfile、脚本、CI 工作流。 */
function imageReferenceFiles(): string[] {
  return [
    ...readdirSync(root).filter(
      (name) =>
        /^docker-compose.*\.ya?ml$/.test(name) || /^Dockerfile/.test(name),
    ),
    ...readdirSync(join(root, 'docker'))
      .map((dir) => `docker/${dir}/Dockerfile`)
      .filter((file) => existsSync(join(root, file))),
    ...readdirSync(join(root, 'scripts'))
      .filter((name) => name.endsWith('.sh'))
      .map((name) => `scripts/${name}`),
    ...readdirSync(join(root, '.github/workflows'))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => `.github/workflows/${name}`),
  ];
}

describe('container image sources', () => {
  it('applies Debian security updates in the runtime image', () => {
    const [, productionStage] = read('Dockerfile.prod').split(
      '# --- production stage',
    );

    // node:22-slim 的系统包会落后 bookworm-security，而 CI 与发版流水线的 Trivy
    // 门禁拦截任何「已有修复」的 HIGH/CRITICAL —— libpcre2-8-0 的
    // CVE-2026-86145 / CVE-2026-89161 就这样把 main 的镜像扫描卡红。
    // 与 Dockerfile.caddy 的 `apk upgrade` 同一思路：构建时补齐系统包。
    expect(productionStage).toContain('apt-get upgrade -y');
    expect(productionStage.indexOf('apt-get upgrade -y')).toBeLessThan(
      productionStage.indexOf('USER app'),
    );
  });

  it('pulls MinIO images from quay.io, not the removed Docker Hub repositories', () => {
    // Docker Hub 上的 minio/minio 与 minio/mc 都已下架（pull 报 repository does
    // not exist）：真实 MinIO 集成测试、bundled-storage 部署（含 minio-init）
    // 和备份镜像构建都会卡在拉镜像这一步。
    const offenders = imageReferenceFiles().filter((file) =>
      /(^|[\s"'=])minio\/(minio|mc):/m.test(read(file)),
    );

    expect(offenders).toEqual([]);
    expect(read('scripts/test-minio-integration.sh')).toContain(
      'quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z',
    );
    const compose = read('docker-compose.prod.yml');
    expect(compose).toContain(
      'image: quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z',
    );
    expect(compose).toContain(
      'image: quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z',
    );
    expect(read('docker/backup/Dockerfile')).toContain(
      'FROM quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z AS mc',
    );
  });
});
