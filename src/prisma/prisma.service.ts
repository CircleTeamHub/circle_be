import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from 'src/generated/prisma';
import { getServerConfig } from 'src/config/server.config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const config = getServerConfig();
    const connectionString =
      process.env.DATABASE_URL ??
      (config['DATABASE_URL'] as string | undefined) ??
      '';

    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not configured. Set it in your environment or .env file.',
      );
    }

    super({
      adapter: new PrismaPg({ connectionString }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
