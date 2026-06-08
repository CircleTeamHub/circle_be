/* eslint-disable */

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const LOCAL_DOCKER_DATABASE_HOSTS = new Set(['db', 'postgres']);

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value ?? ''));
}

function isLocalDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return false;
  try {
    const parsed = new URL(databaseUrl);
    return (
      LOCAL_DATABASE_HOSTS.has(parsed.hostname) ||
      LOCAL_DOCKER_DATABASE_HOSTS.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function assertDevSeedAllowed(env = process.env) {
  if (isTruthy(env.ALLOW_NON_LOCAL_SEED)) {
    return;
  }

  if (env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run dev seed script with NODE_ENV=production. Set ALLOW_NON_LOCAL_SEED=true only for an intentional one-off run.',
    );
  }

  if (!isLocalDatabaseUrl(env.DATABASE_URL)) {
    throw new Error(
      'Refusing to run dev seed script against a non-local DATABASE_URL. Set ALLOW_NON_LOCAL_SEED=true only for an intentional one-off run.',
    );
  }
}

module.exports = {
  assertDevSeedAllowed,
  isLocalDatabaseUrl,
};
