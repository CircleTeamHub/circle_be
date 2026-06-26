import * as fs from 'fs';
import * as dotenv from 'dotenv';

function getEnv(env: string): Record<string, unknown> {
  // Env filenames are built internally from NODE_ENV; no user path input reaches here.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (fs.existsSync(env)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return dotenv.parse(fs.readFileSync(env));
  }
  return {};
}

export function getServerConfig(): Record<string, unknown> {
  const defaultConfig = getEnv('.env');
  const envConfig = getEnv(`.env.${process.env.NODE_ENV || 'development'}`);
  return { ...defaultConfig, ...envConfig };
}
