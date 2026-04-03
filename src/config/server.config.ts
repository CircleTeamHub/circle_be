import * as fs from 'fs';
import * as dotenv from 'dotenv';

function getEnv(env: string): Record<string, unknown> {
  if (fs.existsSync(env)) {
    return dotenv.parse(fs.readFileSync(env));
  }
  return {};
}

export function getServerConfig(): Record<string, unknown> {
  const defaultConfig = getEnv('.env');
  const envConfig = getEnv(`.env.${process.env.NODE_ENV || 'development'}`);
  return { ...defaultConfig, ...envConfig };
}
