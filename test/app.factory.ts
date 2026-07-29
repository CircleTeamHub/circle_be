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
    // User.accountId and AccountIdentifier.currentUserID deliberately form a
    // claim cycle, so row-by-row deletes cannot remove either side first.
    // This helper is guarded to an explicit test database above; CASCADE gives
    // every e2e case a clean user-owned graph without weakening production FKs.
    await this.prisma.$executeRaw`
      TRUNCATE TABLE "User", "AccountIdentifier" CASCADE
    `;
    // Reset the staged-rollout singleton so each test starts DISABLED. Quota
    // tests that need the enforced (non-floored) limits enable it explicitly;
    // without this reset an enablement would leak into later tests.
    await this.prisma.membershipProgramState.deleteMany();
  }

  async cleanup() {
    await this.initDB();
  }

  async destory() {
    await this.app.close();
  }
}
