import { Module } from '@nestjs/common';
import { NoteModule } from 'src/note/note.module';
import { AdminUserModule } from './admin-user.module';
import { AdminUserResourcesController } from './admin-user-resources.controller';
import { AdminUserResourcesService } from './admin-user-resources.service';
@Module({
  imports: [NoteModule, AdminUserModule],
  controllers: [AdminUserResourcesController],
  providers: [AdminUserResourcesService],
})
export class AdminUserResourcesModule {}
