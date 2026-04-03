import { defineConfig } from 'prisma/config';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

// Load env for CLI commands (migrate, studio, etc.)
function loadEnv(): Record<string, string> {
  const env = process.env.NODE_ENV || 'development';
  const base = fs.existsSync('.env') ? dotenv.parse(fs.readFileSync('.env')) : {};
  const specific = fs.existsSync(`.env.${env}`)
    ? dotenv.parse(fs.readFileSync(`.env.${env}`))
    : {};
  return { ...base, ...specific } as Record<string, string>;
}

const config = loadEnv();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: config['DATABASE_URL'],
  },
});
