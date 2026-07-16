import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { INestApplication } from '@nestjs/common';
import { setupApp } from '../src/setup';
import { PrismaService } from '../src/prisma/prisma.service';

export function assertSafeE2eDatabase(
  databaseUrl = process.env.DATABASE_URL,
  nodeEnv = process.env.NODE_ENV,
): void {
  if (nodeEnv !== 'test' || !databaseUrl) {
    throw new Error('E2E cleanup requires NODE_ENV=test and DATABASE_URL');
  }

  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.slice(1),
  );
  if (!/(^|[_-])test($|[_-])/i.test(databaseName)) {
    throw new Error(`Refusing to clean non-test database: ${databaseName}`);
  }
}

export class AppFactory {
  private prisma: PrismaService;

  constructor(private app: INestApplication) {
    this.prisma = app.get(PrismaService);
  }

  get instance() {
    return this.app;
  }

  static async init() {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleFixture.createNestApplication();
    setupApp(app);
    await app.listen(0); // random port to avoid conflicts
    return new AppFactory(app);
  }

  // Clear all test data in dependency order
  async initDB() {
    assertSafeE2eDatabase();
    await this.prisma.refreshToken.deleteMany();
    await this.prisma.user.deleteMany();
  }

  async cleanup() {
    await this.initDB();
  }

  async destory() {
    await this.app.close();
  }
}
