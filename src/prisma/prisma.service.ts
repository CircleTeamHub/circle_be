import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from 'src/generated/prisma';
import {
  allowsStartWithoutDatabase,
  shouldSkipPrismaConnectOnBoot,
} from 'src/config/env.validation';
import { getServerConfig } from 'src/config/server.config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly connectionString: string;
  private readonly allowStartWithoutDb: boolean;
  private isConnected = false;

  constructor() {
    const config = getServerConfig();
    const connectionString =
      process.env.DATABASE_URL ??
      (config['DATABASE_URL'] as string | undefined) ??
      '';
    const allowStartWithoutDb = allowsStartWithoutDatabase(process.env);

    if (!connectionString && !allowStartWithoutDb) {
      throw new Error(
        'DATABASE_URL is not configured. Set it in your environment or .env file.',
      );
    }

    super(
      connectionString
        ? {
            adapter: new PrismaPg({ connectionString }),
          }
        : {},
    );

    this.connectionString = connectionString;
    this.allowStartWithoutDb = allowStartWithoutDb;
  }

  async onModuleInit() {
    if (this.shouldSkipConnectionOnBoot()) {
      this.logger.warn(
        'Skipping Prisma connection during bootstrap because startup connection is disabled or DATABASE_URL is unavailable.',
      );
      return;
    }

    try {
      await this.$connect();
      this.isConnected = true;
      this.logger.log('PrismaClient connected to database successfully');
    } catch (error) {
      this.isConnected = false;

      if (this.allowStartWithoutDb) {
        this.logger.error(
          `Database connection error: ${error instanceof Error ? error.message : String(error)}`,
          'Application will continue without database connection.',
        );
        return;
      }

      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.isConnected = false;
  }

  isDatabaseConnected(): boolean {
    return this.isConnected;
  }

  async connectIfNeeded(): Promise<boolean> {
    if (this.isConnected) {
      return true;
    }

    if (!this.connectionString) {
      this.logger.warn(
        'Database connection requested but DATABASE_URL is not configured.',
      );
      return false;
    }

    try {
      await this.$connect();
      this.isConnected = true;
      this.logger.log('PrismaClient connected to database successfully');
      return true;
    } catch (error) {
      this.isConnected = false;
      this.logger.error(
        `Failed to connect to database: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private shouldSkipConnectionOnBoot(): boolean {
    if (!this.connectionString) {
      return true;
    }

    return shouldSkipPrismaConnectOnBoot(process.env);
  }
}
