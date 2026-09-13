import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

/** compose 文件里某个 service 的块：到下一个同级键或顶层键为止。 */
function serviceBlock(compose: string, name: string): string | undefined {
  const match = new RegExp(
    `\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9_-]+:\\n|\\n[a-z]|$)`,
  ).exec(compose);
  return match?.[1];
}

/** Prometheus 配置里某个 scrape job 的块。 */
function scrapeJob(config: string, job: string): string | undefined {
  const match = new RegExp(
    `- job_name: ${job}\\n([\\s\\S]*?)(?=\\n  - job_name:|$)`,
  ).exec(config);
  return match?.[1];
}

// 公网可达性由 blackbox_exporter 负责，替代原来的 Uptime-Kuma：探测配置进仓库、
// 告警走 Alertmanager 的分级与抑制，而不是藏在一个 Web UI 的数据卷里直连 Discord。
describe('public reachability monitoring (blackbox_exporter)', () => {
  const base = read('monitoring/docker-compose.yml');
  const prod = read('monitoring/docker-compose.prod.yml');
  const prometheusProd = read('monitoring/prometheus/prometheus.prod.yml');

  it('drops Uptime-Kuma from both compose files', () => {
    for (const compose of [base, prod]) {
      expect(compose).not.toMatch(/uptime[-_ ]?kuma/i);
    }
  });

  it('runs a pinned blackbox exporter only in the production overlay', () => {
    // 开发机没有公网域名：放进基础文件只会得到一个永远没有目标的探测器。
    expect(serviceBlock(base, 'blackbox-exporter')).toBeUndefined();

    const service = serviceBlock(prod, 'blackbox-exporter');
    expect(service).toBeDefined();
    expect(service).toContain('image: prom/blackbox-exporter:v0.28.0');
    expect(service).toContain(
      './blackbox/blackbox.yml:/etc/blackbox_exporter/config.yml:ro',
    );
    // 只给 Prometheus 在监控网络里调用，不发布宿主端口。
    expect(service).not.toMatch(/\n\s+ports:/);
  });

  it('probes public targets through the exporter, passing each target as a parameter', () => {
    const job = scrapeJob(prometheusProd, 'blackbox-http');
    expect(job).toBeDefined();
    expect(job).toContain('metrics_path: /probe');
    expect(job).toMatch(/module: \[http_2xx\]/);
    expect(job).toContain("- files: ['/etc/prometheus/probe-targets/*.yml']");
    expect(job).toMatch(
      /source_labels: \[__address__\]\s*\n\s*target_label: __param_target/,
    );
    expect(job).toMatch(
      /source_labels: \[__param_target\]\s*\n\s*target_label: instance/,
    );
    expect(job).toMatch(
      /target_label: __address__\s*\n\s*replacement: blackbox-exporter:9115/,
    );

    // exporter 自己也要被抓：它挂了，TargetDown 才会响。
    expect(scrapeJob(prometheusProd, 'blackbox-exporter')).toContain(
      "targets: ['blackbox-exporter:9115']",
    );
    // 开发配置不探测。
    expect(read('monitoring/prometheus/prometheus.yml')).not.toContain(
      'blackbox',
    );
  });

  it('mounts per-deployment probe targets that never enter the repository', () => {
    expect(serviceBlock(prod, 'prometheus')).toContain(
      './prometheus/probe-targets:/etc/prometheus/probe-targets:ro',
    );
    expect(read('monitoring/prometheus/probe-targets/.gitignore')).toMatch(
      /^\*\.yml$/m,
    );

    const example = read(
      'monitoring/prometheus/probe-targets/public.yml.example',
    );
    expect(example).toMatch(/https:\/\/\S+\/healthz/);
    expect(example).toMatch(/component: api/);
    // Caddy 对公网把 /readyz 返回 404：探它等于常年红。
    expect(example).not.toContain('/readyz');
  });

  it('requires TLS on every probe and prefers IPv4', () => {
    const blackbox = read('monitoring/blackbox/blackbox.yml');
    expect(blackbox).toMatch(/http_2xx:\s*\n\s*prober: http/);
    expect(blackbox).toContain('fail_if_not_ssl: true');
    expect(blackbox).toContain('preferred_ip_protocol: ip4');
  });

  it('validates both Prometheus configs and the blackbox config in CI', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('check config /etc/prometheus/prometheus.yml');
    expect(ci).toContain('check config /etc/prometheus/prometheus.prod.yml');
    // 与生产 overlay 锁定的版本一致。
    expect(ci).toContain('prom/blackbox-exporter:v0.28.0');
    expect(ci).toContain('--config.check');
  });
});
