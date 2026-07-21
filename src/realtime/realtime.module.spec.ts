import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from 'src/auth/auth.module';
import { IconModule } from 'src/icon/icon.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisModule } from 'src/redis/redis.module';
import { RealtimeModule } from './realtime.module';
import { RealtimeGateway } from './realtime.gateway';

describe('RealtimeModule wiring', () => {
  // Guards the AuthModule export: the gateway resolves SessionRevocationService
  // through the global AuthModule, which unit tests (which construct the gateway
  // by hand) cannot catch.
  it('constructs RealtimeGateway with SessionRevocationService injected', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
        PrismaModule,
        RedisModule,
        IconModule,
        AuthModule,
        RealtimeModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(RealtimeGateway)).toBeInstanceOf(RealtimeGateway);
    await moduleRef.close();
  });
});
