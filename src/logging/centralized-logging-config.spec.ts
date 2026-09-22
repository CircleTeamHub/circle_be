import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';

interface ComposeFile {
  services: Record<
    string,
    {
      image?: string;
      user?: string;
      volumes?: string[];
      networks?: string[];
      ports?: string[];
      privileged?: boolean;
      read_only?: boolean;
      command?: string[];
    }
  >;
  volumes: Record<string, { external?: boolean; name?: string } | null>;
  networks?: Record<string, { internal?: boolean }>;
}

const read = (path: string) =>
  readFileSync(join(__dirname, '..', '..', path), 'utf8');
const compose = (path: string) => load(read(path)) as ComposeFile;

describe('optional centralized log deployment', () => {
  const app = compose('docker-compose.prod.yml');
  const release = compose('docker-compose.release.yml');
  const logs = compose('monitoring/docker-compose.logs.yml');
  const alloy = read('monitoring/alloy/config.alloy');

  it('keeps both colors in persistent, separate, project-scoped log volumes', () => {
    expect(app.services.circle_be.volumes).toContain('app_logs_blue:/app/logs');
    expect(release.services.circle_be_green.volumes).toContain(
      'app_logs_green:/app/logs',
    );
    expect(app.volumes).toHaveProperty('app_logs_blue');
    expect(release.volumes).toHaveProperty('app_logs_green');
    for (const color of ['blue', 'green']) {
      expect(logs.volumes[`app_logs_${color}`]).toEqual({
        external: true,
        name: `\${CIRCLE_BE_PROJECT_NAME:-circle-be}_app_logs_${color}`,
      });
      expect(logs.services.alloy.volumes).toContain(
        `app_logs_${color}:/var/log/circle/${color}:ro`,
      );
    }
    // Fresh named volumes copy this directory's non-root ownership.
    expect(read('Dockerfile.prod')).toContain(
      'install -d -o app -g app /app/logs',
    );
  });

  it('isolates unauthenticated log endpoints and needs no Docker or host access', () => {
    expect(logs.networks.logs.internal).toBe(true);
    for (const name of ['loki', 'alloy']) {
      const service = logs.services[name];
      expect(service.ports).toBeUndefined();
      expect(service.privileged).not.toBe(true);
      expect(service.read_only).toBe(true);
      expect(service.user).toMatch(/^[1-9]\d*:[1-9]\d*$/);
      expect(service.networks).toEqual(['logs']);
      expect(service.image).not.toMatch(/:latest$/);
      expect(service.volumes.join('\n')).not.toMatch(
        /docker\.sock|\/var\/lib\/docker|^\/:/m,
      );
    }
  });

  it('persists collector offsets and WAL and enables seven-day Loki retention', () => {
    expect(logs.services.alloy.volumes).toContain(
      'alloy_data:/var/lib/alloy/data',
    );
    expect(logs.services.alloy.command).toContain(
      '--storage.path=/var/lib/alloy/data',
    );
    expect(logs.services.alloy.command).toContain(
      '--stability.level=experimental',
    );
    expect(alloy).toMatch(/wal\s*\{\s*enabled\s*=\s*true/);
    expect(logs.services.loki.volumes).toContain('loki_data:/loki');
    const loki = load(read('monitoring/loki/config.yml')) as {
      common: { path_prefix: string };
      ingester: { wal: { enabled: boolean; dir: string } };
      compactor: {
        retention_enabled: boolean;
        working_directory: string;
        delete_request_store: string;
      };
      limits_config: {
        retention_period: string;
        discover_service_name: string[];
      };
    };
    expect(loki.common.path_prefix).toBe('/loki');
    expect(loki.ingester.wal).toMatchObject({
      enabled: true,
      dir: '/loki/wal',
    });
    expect(loki.compactor).toMatchObject({
      retention_enabled: true,
      working_directory: '/loki/compactor',
      delete_request_store: 'filesystem',
    });
    expect(loki.limits_config.retention_period).toBe('168h');
    expect(loki.limits_config.discover_service_name).toEqual([]);
  });

  it('keeps correlation IDs in JSON and only indexes bounded labels', () => {
    expect(alloy).toMatch(
      /stage\.label_keep\s*\{\s*values\s*=\s*\["service", "environment", "level"\]/,
    );
    expect(alloy).toContain('error|warn|info|http|verbose|debug|silly');
    expect(alloy).toContain('drop_malformed = true');
    expect(alloy).toContain('/var/log/circle/{blue,green}/application-*.log*');
    expect(alloy).not.toContain('error-*.log');
  });

  it('provisions Loki only when the optional overlay is enabled', () => {
    const disabled = load(
      read('monitoring/grafana/provisioning/datasources/loki.yml'),
    ) as { datasources: unknown[] };
    expect(disabled.datasources).toEqual([]);
    expect(logs.services.grafana.volumes).toContain(
      './grafana/provisioning/datasources/loki.yml.example:/etc/grafana/provisioning/datasources/loki.yml:ro',
    );
    expect(logs.services.grafana.networks).toEqual(['default', 'logs']);
    const datasource = load(
      read('monitoring/grafana/provisioning/datasources/loki.yml.example'),
    ) as { prune: boolean; datasources: { uid: string; isDefault: boolean }[] };
    expect(datasource.prune).toBe(true);
    expect(datasource.datasources[0]).toMatchObject({
      uid: 'loki',
      isDefault: false,
    });
  });
});
