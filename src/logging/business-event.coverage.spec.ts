import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Every business / security event name used in code must be documented in
 * docs/logging.md — that document is what an operator greps when a dashboard
 * shows an unfamiliar `businessEvent` label, and the Prometheus label budget
 * (`business_events_total{event}` is capped at 100 names) has to be visible
 * somewhere humans can review. Same spirit as tracked-cron.coverage.spec.ts.
 */
const SRC_ROOT = join(__dirname, '..');
const DOCS = readFileSync(join(SRC_ROOT, '..', 'docs', 'logging.md'), 'utf8');
const EVENT_NAME = /^[a-z]+(?:_[a-z0-9]+)+$/;
const MAX_EVENT_NAMES = 100;

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'generated' || entry === 'node_modules') continue;
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.ts$/.test(entry) && !/\.spec\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Matches the *value* of `businessEvent:` / `securityEvent:` at a call site:
 * either a single literal, or a ternary of two literals (possibly spanning
 * lines). Type annotations (`securityEvent: string;`) and pass-throughs
 * (`securityEvent: payload.securityEvent`) match neither branch and are
 * skipped, so the logger definitions themselves never pollute the inventory.
 */
function valuePattern(property: 'businessEvent' | 'securityEvent'): RegExp {
  return new RegExp(
    `${property}:\\s*(?:'([a-z0-9_]+)'|(?:[^,;'{}]|\\n)*?\\?\\s*'([a-z0-9_]+)'\\s*:\\s*'([a-z0-9_]+)')`,
    'g',
  );
}

function collectEventNames(property: 'businessEvent' | 'securityEvent') {
  const found = new Map<string, string[]>();
  const pattern = valuePattern(property);
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const source = readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      for (const name of match.slice(1).filter(Boolean)) {
        const sites = found.get(name) ?? [];
        sites.push(relative(SRC_ROOT, file));
        found.set(name, sites);
      }
    }
  }
  return found;
}

describe('business & security event catalogue', () => {
  const businessEvents = collectEventNames('businessEvent');
  const securityEvents = collectEventNames('securityEvent');

  it('finds the instrumented call sites (guards the scanner itself)', () => {
    expect(businessEvents.size).toBeGreaterThan(30);
    expect(securityEvents.size).toBeGreaterThan(3);
    // A pass-through or a type annotation must not be mistaken for a name.
    expect([...businessEvents.keys()]).not.toContain('string');
    expect([...businessEvents.keys()]).not.toContain('password');
  });

  it('uses stable snake_case names that fit the metrics label budget', () => {
    const offenders = [
      ...businessEvents.keys(),
      ...securityEvents.keys(),
    ].filter((name) => !EVENT_NAME.test(name));
    expect(offenders).toEqual([]);
    expect(businessEvents.size).toBeLessThan(MAX_EVENT_NAMES);
  });

  it('documents every business event in docs/logging.md', () => {
    const undocumented = [...businessEvents.entries()]
      .filter(([name]) => !DOCS.includes(`\`${name}\``))
      .map(([name, sites]) => `${name} (${[...new Set(sites)].join(', ')})`);
    expect(undocumented).toEqual([]);
  });

  it('documents every security event in docs/logging.md', () => {
    const undocumented = [...securityEvents.entries()]
      .filter(([name]) => !DOCS.includes(`\`${name}\``))
      .map(([name, sites]) => `${name} (${[...new Set(sites)].join(', ')})`);
    expect(undocumented).toEqual([]);
  });
});
