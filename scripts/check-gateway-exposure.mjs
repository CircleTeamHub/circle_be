import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Consume normalized Compose JSON, including all release/monitoring overrides.
// Never print the config: it may contain production credentials.
export function exposureIssues(config) {
  if (!config?.services || Object.keys(config.services).length === 0) {
    return ['No services found in Compose configuration'];
  }
  const issues = [];
  for (const [name, service] of Object.entries(config.services)) {
    if (service.network_mode === 'host')
      issues.push(`${name}: host networking bypasses ingress isolation`);
    if (service.privileged) issues.push(`${name}: privileged container`);
    for (const port of service.ports ?? []) {
      if (!port || typeof port !== 'object') {
        issues.push(`${name}: expected normalized Compose port object`);
        continue;
      }
      if (port.host_ip === '127.0.0.1' || port.host_ip === '::1') continue;
      if (
        name === 'caddy' &&
        ['80', '443'].includes(String(port.published)) &&
        Number(port.target) === Number(port.published)
      )
        continue;
      issues.push(
        `${name}: unexpected public port ${port.published ?? 'dynamic'}`,
      );
    }
  }
  return issues;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const issues = exposureIssues(JSON.parse(readFileSync(0, 'utf8')));
    if (issues.length) {
      for (const issue of issues) console.error(issue);
      process.exitCode = 1;
    } else
      console.log(
        'Gateway exposure check passed: only Caddy publishes public ports.',
      );
  } catch {
    console.error('Unable to validate normalized Compose JSON');
    process.exitCode = 1;
  }
}
