import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { INestApplication } from '@nestjs/common';
import { setupApp } from '../src/setup';
import { PrismaService } from '../src/prisma/prisma.service';

export class AppFactory {
  private prisma: PrismaService;

  constructor(private app: INestApplication) {
    this.prisma = app.get(PrismaService);
  }

  get instance() {
    return this.app;
  }

  get database() {
    return this.prisma;
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
