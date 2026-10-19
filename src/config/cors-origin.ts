type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;

// Dev/test: also allow localhost/loopback on any port. Avoid `cors: true`
// (reflect-any-origin) which lets any page on the LAN ride the user's
// credentials.
const DEV_ORIGIN_PATTERNS: RegExp[] = [
  // Fixed allowlist regexes for local/dev CORS origins.
  // eslint-disable-next-line security/detect-unsafe-regex
  /^https?:\/\/localhost(:\d+)?$/,
  // eslint-disable-next-line security/detect-unsafe-regex
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  // eslint-disable-next-line security/detect-unsafe-regex
  /^https?:\/\/\[::1\](:\d+)?$/,
  // eslint-disable-next-line security/detect-unsafe-regex
  /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
  // eslint-disable-next-line security/detect-unsafe-regex
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
];

export function resolveCorsOriginChecker(
  env: NodeJS.ProcessEnv = process.env,
): (origin: string | undefined, callback: CorsOriginCallback) => void {
  // Every env read below happens per request, not at factory time. This factory
  // runs from buildNestFactoryOptions() — i.e. while evaluating the arguments to
  // NestFactory.create(), before ConfigModule has loaded `.env.<NODE_ENV>` into
  // process.env. Reading eagerly froze the allowlist as empty in production,
  // which silently blocks every browser origin.
  return (origin, callback) => {
    // Same-origin / curl / mobile webviews have no Origin header — allow.
    if (!origin) return callback(null, true);

    const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    if (allowedOrigins.includes(origin)) return callback(null, true);

    const isProduction = env.NODE_ENV === 'production';
    if (!isProduction && DEV_ORIGIN_PATTERNS.some((re) => re.test(origin))) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked: ${origin}`), false);
  };
}
