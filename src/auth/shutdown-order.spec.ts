import { NestFactory } from '@nestjs/core';
import { AppModule } from 'src/app.module';
import { AuthModule } from './auth.module';
import { PrismaModule } from 'src/prisma/prisma.module';

/**
 * DeviceTrustService.onModuleDestroy waits for in-flight login alerts before
 * the pool closes, which only works if AuthModule is destroyed before
 * PrismaModule. Both are global, so Nest orders them by scan order (later
 * scanned → destroyed first): reordering AppModule's imports, or importing
 * AuthModule from a module scanned before PrismaModule, would flip it.
 * Preview mode builds the module graph without instantiating any provider.
 */
describe('application shutdown order', () => {
  it('destroys AuthModule before PrismaModule', async () => {
    const app = await NestFactory.createApplicationContext(AppModule, {
      preview: true,
      logger: false,
      abortOnError: false,
    });
    try {
      const modules = Array.from(
        (app as any).container.getModules().values(),
      ) as Array<{ metatype: unknown; distance: number }>;
      // Same ordering NestApplicationContext.callDestroyHook uses.
      const destroyOrder = [...modules]
        .sort((a, b) => b.distance - a.distance)
        .reverse()
        .map(({ metatype }) => metatype);
      const auth = destroyOrder.indexOf(AuthModule);
      const prisma = destroyOrder.indexOf(PrismaModule);
      expect(auth).toBeGreaterThanOrEqual(0);
      expect(prisma).toBeGreaterThanOrEqual(0);
      expect(auth).toBeLessThan(prisma);
    } finally {
      await app.close();
    }
  });
});
