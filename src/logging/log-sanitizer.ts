import {
  DYNAMIC_ROUTE_TEMPLATES,
  normalizeRoute,
  OTHER_ROUTE,
  STATIC_ROUTES,
} from '../metrics/route-normalizer';

const REDACTED = '[redacted]';
const MAX_STRING = 2048;
const MAX_DEPTH = 5;
const MAX_ENTRIES = 50;
const MAX_NODES = 500;
// Node 24+ exposes Error.stack through one shared native accessor. Only this
// exact getter is allowed; application-defined accessors are never evaluated.
const NATIVE_STACK_GETTER = Object.getOwnPropertyDescriptor(
  new Error(),
  'stack',
)?.get;
const KNOWN_ROUTES = new Set([...STATIC_ROUTES, ...DYNAMIC_ROUTE_TEMPLATES]);
const PRIVATE_KEY =
  /password|token|secret|authorization|cookie|email|phone|mobile|device|useragent|address|latitude|longitude/;
const PRIVATE_FIELDS = new Set([
  'body',
  'requestbody',
  'responsebody',
  'payload',
  'request',
  'response',
  'req',
  'res',
  'headers',
  'query',
  'params',
  'content',
  'text',
  'word',
  'messages',
  'chat',
  'chatmessage',
  'data',
  'args',
  'arguments',
  'sql',
  'cause',
  'ip',
  'remoteaddress',
  'name',
  'username',
  'nickname',
  'displayname',
  'code',
  'securitycode',
  'verificationcode',
  'filename',
  'objectkey',
  'key',
]);

/** Only route templates are loggable; even the first unknown path is private. */
export function safeLogPath(path: string): string {
  if (typeof path !== 'string' || path.length > MAX_STRING) return OTHER_ROUTE;
  const normalized = normalizeRoute(path.split('#')[0]);
  return KNOWN_ROUTES.has(normalized) ? normalized : OTHER_ROUTE;
}

/** Defense in depth for legacy prose. New logs should use structured events. */
export function sanitizeLogText(value: string): string {
  const bounded = value.slice(0, MAX_STRING);
  return (
    bounded
      .replace(/https?:\/\/[^\s<>"']+/gi, '[redacted-url]')
      .replace(/Bearer\s+[^\s,"'}]+/gi, `Bearer ${REDACTED}`)
      .replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, REDACTED)
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
      .replace(
        /\b(?:authorization|cookie)\s*[=:]\s*[^\r\n]*/gi,
        (match) => `${match.split(/[=:]/)[0]}=${REDACTED}`,
      )
      .replace(
        /\b([A-Za-z][A-Za-z_-]{0,63})\s*[=:]\s*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;]+)/g,
        (match, key: string) => {
          const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
          return PRIVATE_KEY.test(normalized) ||
            PRIVATE_FIELDS.has(normalized) ||
            normalized === 'apikey'
            ? `${key}=${REDACTED}`
            : match;
        },
      )
      .replace(
        /(^|[\s("'=])(\/[^\s<>"']+)/g,
        (_match, prefix: string, path: string) =>
          `${prefix}${safeLogPath(path)}`,
      )
      .replace(
        /\b(body|payload|content|sql|query)\s*[=:][^\r\n]*/gi,
        `$1=${REDACTED}`,
      )
      .replace(/[\u0000-\u001f\u007f]/g, ' ') +
    (value.length > MAX_STRING ? '[truncated]' : '')
  );
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function errorName(value: unknown): string {
  return typeof value === 'string' &&
    /^(?:Error|[A-Za-z][A-Za-z0-9]{0,79}(?:Error|Exception))$/.test(value)
    ? value
    : 'Error';
}

/** Preserve source call sites, never the first line or arbitrary stack prose. */
function safeStack(value: unknown): string | undefined {
  let stack = typeof value === 'string' ? value : '';
  if (Array.isArray(value)) {
    for (let index = 0; index < 3; index++) {
      const item = dataProperty(value, String(index));
      if (typeof item === 'string') stack += `${item.slice(0, 16000)}\n`;
    }
  }
  const sites = stack
    .slice(0, 16000)
    .split('\n')
    .slice(0, 40)
    .flatMap((line) => {
      if (!/^\s*at\s/.test(line)) return [];
      const location = /(?:^at\s+|[\\/])([A-Za-z0-9_.-]+:\d+:\d+)\)?$/.exec(
        line.trim(),
      );
      return location ? [`at ${location[1]}`] : [];
    });
  return sites.length ? sites.slice(0, 20).join('\n') : undefined;
}

function hasErrorTextAccessor(error: Error): boolean {
  // Native lazy stack generation reads name/message via Error#toString.
  let target: object | null = error;
  for (let depth = 0; target && depth < MAX_DEPTH; depth++) {
    if (
      ['name', 'message'].some(
        (key) => Object.getOwnPropertyDescriptor(target, key)?.get,
      )
    )
      return true;
    target = Object.getPrototypeOf(target);
  }
  return target !== null;
}

/**
 * Bounded, non-mutating serialization boundary. Accessors/toJSON and symbol
 * metadata are intentionally not copied. Account/entity/request identifiers
 * remain for operational correlation; contact and device identifiers do not.
 */
export function sanitizeLogValue(value: unknown): unknown {
  const ancestors = new WeakSet<object>();
  let remaining = MAX_NODES;
  function visit(current: unknown, depth: number, key = ''): unknown {
    try {
      if (--remaining < 0 || depth > MAX_DEPTH) return '[truncated]';
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
      if (
        PRIVATE_KEY.test(normalizedKey) ||
        PRIVATE_FIELDS.has(normalizedKey) ||
        (normalizedKey === 'message' && depth > 1)
      )
        return REDACTED;
      if (normalizedKey === 'stack' || normalizedKey === 'trace')
        return safeStack(current);
      if (normalizedKey === 'errorname') return errorName(current);
      if (typeof current === 'string') {
        if (
          ['error', 'err', 'exception', 'errormessage'].includes(normalizedKey)
        )
          return REDACTED;
        if (
          ['path', 'route', 'originalurl', 'url', 'pathname'].includes(
            normalizedKey,
          )
        )
          return safeLogPath(current);
        return sanitizeLogText(current);
      }
      if (
        current === null ||
        current === undefined ||
        typeof current === 'boolean'
      )
        return current;
      if (typeof current === 'number')
        return Number.isFinite(current) ? current : String(current);
      if (typeof current === 'bigint') return current.toString();
      if (typeof current !== 'object') return '[unsupported]';
      if (ancestors.has(current)) return '[circular]';
      if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer)
        return '[binary]';
      if (current instanceof Date)
        return Date.prototype.toISOString.call(current);
      if (current instanceof Error) {
        const ownName = dataProperty(current, 'name');
        const prototypeName = dataProperty(
          Object.getPrototypeOf(current),
          'name',
        );
        const stackDescriptor = Object.getOwnPropertyDescriptor(
          current,
          'stack',
        );
        const stack =
          stackDescriptor?.get &&
          stackDescriptor.get === NATIVE_STACK_GETTER &&
          !hasErrorTextAccessor(current)
            ? stackDescriptor.get.call(current)
            : dataProperty(current, 'stack');
        return {
          name: errorName(ownName ?? prototypeName),
          message: REDACTED,
          stack: safeStack(stack),
        };
      }
      ancestors.add(current);
      try {
        if (Array.isArray(current)) {
          const result: unknown[] = [];
          for (
            let index = 0;
            index < Math.min(current.length, MAX_ENTRIES);
            index++
          ) {
            result.push(visit(dataProperty(current, String(index)), depth + 1));
          }
          if (current.length > MAX_ENTRIES) result.push('[truncated]');
          return result;
        }
        const result: Record<string, unknown> = Object.create(null);
        let count = 0;
        for (const entryKey in current) {
          if (!Object.prototype.hasOwnProperty.call(current, entryKey))
            continue;
          if (++count > MAX_ENTRIES) {
            result.truncated = true;
            break;
          }
          if (
            entryKey === 'toJSON' ||
            entryKey === '__proto__' ||
            entryKey === 'constructor'
          )
            continue;
          const descriptor = Object.getOwnPropertyDescriptor(current, entryKey);
          const safeKey = sanitizeLogText(entryKey.slice(0, 128));
          result[safeKey] =
            descriptor && 'value' in descriptor
              ? visit(descriptor.value, depth + 1, entryKey)
              : '[accessor]';
        }
        // Error-shaped objects include ORM/HTTP library errors that are not
        // Error subclasses. Their message can contain SQL, bodies or contacts.
        if (
          'message' in result &&
          ('stack' in result ||
            'error' in result ||
            result.level === 'error' ||
            key === 'error')
        )
          result.message = REDACTED;
        if (
          ['error', 'err', 'exception'].includes(normalizedKey) &&
          'name' in result
        )
          result.name = errorName(dataProperty(current, 'name'));
        return result;
      } finally {
        ancestors.delete(current);
      }
    } catch {
      return '[unserializable]';
    }
  }
  return visit(value, 0);
}
