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
import { CollectionModule } from './collection/collection.module';
import { NoteModule } from './note/note.module';
import { MembershipModule } from './membership/membership.module';
import { MallModule } from './mall/mall.module';
import { CircleModule } from './circle/circle.module';
import { CirclePlazaModule } from './circle-plaza/circle-plaza.module';
import { CircleInvitationModule } from './circle-invitation/circle-invitation.module';
import { TraceModule } from './trace/trace.module';
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
    MembershipModule,
    MallModule,
    CollectionModule,
    NoteModule,
    CircleModule,
    CirclePlazaModule,
    CircleInvitationModule,
    TraceModule,
  ],
  controllers: [],
  providers: [Logger],
  exports: [Logger],
})
export class AppModule {}
