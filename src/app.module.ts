import { Logger, Module } from '@nestjs/common';
import { UserModule } from './user/user.module';
import { ConfigModule } from '@nestjs/config';
import * as dotenv from 'dotenv';

import { LogsModule } from './logs/logs.module';
import { RolesModule } from './roles/roles.module';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { OpenimModule } from './openim/openim.module';
import { UploadModule } from './upload/upload.module';
import { FriendModule } from './friend/friend.module';
import { CoinModule } from './coin/coin.module';
import { NoteModule } from './note/note.module';
import { createEnvValidationSchema } from './config/env.validation';

const envFilePath = `.env.${process.env.NODE_ENV || `development`}`;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath,
      load: [() => dotenv.config({ path: '.env', quiet: true })],
      validationSchema: createEnvValidationSchema(),
    }),
    PrismaModule,
    UserModule,
    LogsModule,
    RolesModule,
    AuthModule,
    OpenimModule,
    UploadModule,
    FriendModule,
    CoinModule,
    NoteModule,
  ],
  controllers: [],
  providers: [Logger],
  exports: [Logger],
})
export class AppModule {}
