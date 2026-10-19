import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Header,
  UseGuards,
} from '@nestjs/common';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AppAudienceGuard } from 'src/guards/app-audience.guard';
import { AdminGuard } from 'src/guards/admin.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import {
  AdminPermissionGuard,
  RequireAdminPermission,
} from 'src/admin-access/admin-permission.guard';
import type { RequestWithUser } from 'src/auth/types';
import { E2eeService } from './e2ee.service';
import {
  EncryptionRecoverySetupDto,
  EncryptionRecoverDto,
  EncryptionArchiveResolveDto,
  EncryptionArchiveWriteDto,
  EncryptionArchiveReadDto,
  RegisterEncryptionDeviceDto,
  EncryptionDeviceActionDto,
  PublishEncryptionPackageDto,
  EncryptionEpochDto,
  EncryptionEventsDto,
} from './e2ee.dto';

@ApiTags('Text encryption')
@ApiBearerAuth()
@Controller('e2ee')
@UseGuards(JwtGuard, AppAudienceGuard, UserThrottlerGuard)
export class E2eeController {
  constructor(private readonly service: E2eeService) {}
  @Post('conversations/:id/takeover')
  takeover(
    @Req() r: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: EncryptionDeviceActionDto,
  ) {
    return this.service.takeover(r.user.userId, 'APP', id, d);
  }
  @Post('recovery/setup')
  @Header('Cache-Control', 'no-store')
  setupRecovery(
    @Req() r: RequestWithUser,
    @Body() d: EncryptionRecoverySetupDto,
  ) {
    return this.service.setupRecovery(r.user.userId, 'APP', d);
  }
  @Post('recovery/restore')
  @Header('Cache-Control', 'no-store')
  recoverDevice(@Req() r: RequestWithUser, @Body() d: EncryptionRecoverDto) {
    return this.service.recoverDevice(r.user.userId, 'APP', d);
  }
  @Post('archive/resolve')
  @Header('Cache-Control', 'no-store')
  resolveArchive(
    @Req() r: RequestWithUser,
    @Body() d: EncryptionArchiveResolveDto,
  ) {
    return this.service.resolveArchive(r.user.userId, 'APP', d);
  }
  @Post('archive/write')
  @Header('Cache-Control', 'no-store')
  writeArchive(
    @Req() r: RequestWithUser,
    @Body() d: EncryptionArchiveWriteDto,
  ) {
    return this.service.writeArchive(r.user.userId, 'APP', d);
  }
  @Post('archive/read')
  @Header('Cache-Control', 'no-store')
  readArchive(@Req() r: RequestWithUser, @Body() d: EncryptionArchiveReadDto) {
    return this.service.readArchive(r.user.userId, 'APP', d);
  }
  @Get('recovery')
  @Header('Cache-Control', 'no-store')
  recovery(@Req() r: RequestWithUser) {
    return this.service.recoveryInfo(r.user.userId, 'APP');
  }
  @Post('devices') register(
    @Req() r: RequestWithUser,
    @Body() d: RegisterEncryptionDeviceDto,
  ) {
    return this.service.register(r.user.userId, 'APP', d);
  }
  @Get('devices') @Header('Cache-Control', 'no-store') devices(
    @Req() r: RequestWithUser,
  ) {
    return this.service.devices(r.user.userId, 'APP');
  }
  @Post('devices/:id/approve') approve(
    @Req() r: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: EncryptionDeviceActionDto,
  ) {
    return this.service.deviceAction(r.user.userId, 'APP', id, 'approve', d);
  }
  @Post('devices/:id/revoke') revoke(
    @Req() r: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: EncryptionDeviceActionDto,
  ) {
    return this.service.deviceAction(r.user.userId, 'APP', id, 'revoke', d);
  }
  @Post('packages') publish(
    @Req() r: RequestWithUser,
    @Body() d: PublishEncryptionPackageDto,
  ) {
    return this.service.publish(r.user.userId, 'APP', d);
  }
  @Get('conversations/:id') @Header('Cache-Control', 'no-store') directory(
    @Req() r: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.directory(r.user.userId, id);
  }
  @Post('conversations/:id') create(
    @Req() r: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: EncryptionDeviceActionDto,
  ) {
    return this.service.createRoom(r.user.userId, id, d);
  }
  @Post('conversations/:id/epochs') epoch(
    @Req() r: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: EncryptionEpochDto,
  ) {
    return this.service.epoch(r.user.userId, id, d);
  }
  @Post('conversations/:id/events') @Header('Cache-Control', 'no-store') events(
    @Req() r: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: EncryptionEventsDto,
  ) {
    return this.service.events(r.user.userId, 'APP', id, d);
  }
}

@ApiTags('Administrator encryption devices')
@ApiBearerAuth()
@Controller('admin/e2ee')
@UseGuards(JwtGuard, AdminGuard, AdminPermissionGuard, UserThrottlerGuard)
export class AdminE2eeController {
  constructor(private readonly service: E2eeService) {}
  @Post('conversations/:id/takeover')
  @RequireAdminPermission('ACCESS_MANAGE')
  takeover(
    @Req() r: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: EncryptionDeviceActionDto,
  ) {
    return this.service.takeover(r.user.userId, 'AUDIT', id, d);
  }
  @Get('conversations/:id')
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('IM_READ')
  directory(@Req() r: RequestWithUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.directory(r.user.userId, id, 'AUDIT');
  }
  @Post('conversations/:id/epochs')
  @RequireAdminPermission('ACCESS_MANAGE')
  epoch(
    @Req() r: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: EncryptionEpochDto,
  ) {
    return this.service.epoch(r.user.userId, id, d, 'AUDIT');
  }
  @Post('recovery/setup')
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('ACCESS_MANAGE')
  setupRecovery(
    @Req() r: RequestWithUser,
    @Body() d: EncryptionRecoverySetupDto,
  ) {
    return this.service.setupRecovery(r.user.userId, 'AUDIT', d);
  }
  @Post('recovery/restore')
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('ACCESS_MANAGE')
  recoverDevice(@Req() r: RequestWithUser, @Body() d: EncryptionRecoverDto) {
    return this.service.recoverDevice(r.user.userId, 'AUDIT', d);
  }
  @Post('archive/resolve')
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('IM_READ')
  resolveArchive(
    @Req() r: RequestWithUser,
    @Body() d: EncryptionArchiveResolveDto,
  ) {
    return this.service.resolveArchive(r.user.userId, 'AUDIT', d);
  }
  @Post('archive/write')
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('IM_READ')
  writeArchive(
    @Req() r: RequestWithUser,
    @Body() d: EncryptionArchiveWriteDto,
  ) {
    return this.service.writeArchive(r.user.userId, 'AUDIT', d);
  }
  @Post('archive/read')
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('IM_READ')
  readArchive(@Req() r: RequestWithUser, @Body() d: EncryptionArchiveReadDto) {
    return this.service.readArchive(r.user.userId, 'AUDIT', d);
  }
  @Get('recovery')
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('IM_READ')
  recovery(@Req() r: RequestWithUser) {
    return this.service.recoveryInfo(r.user.userId, 'AUDIT');
  }
  @Post('devices') @RequireAdminPermission('IM_READ') register(
    @Req() r: RequestWithUser,
    @Body() d: RegisterEncryptionDeviceDto,
  ) {
    return this.service.register(r.user.userId, 'AUDIT', d);
  }
  @Get('devices')
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('IM_READ')
  devices(@Req() r: RequestWithUser) {
    return this.service.devices(r.user.userId, 'AUDIT');
  }
  @Post('devices/:id/approve') @RequireAdminPermission('ACCESS_MANAGE') approve(
    @Req() r: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: EncryptionDeviceActionDto,
  ) {
    return this.service.deviceAction(r.user.userId, 'AUDIT', id, 'approve', d);
  }
  @Post('devices/:id/revoke') @RequireAdminPermission('ACCESS_MANAGE') revoke(
    @Req() r: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: EncryptionDeviceActionDto,
  ) {
    return this.service.deviceAction(r.user.userId, 'AUDIT', id, 'revoke', d);
  }
  @Post('packages') @RequireAdminPermission('IM_READ') publish(
    @Req() r: RequestWithUser,
    @Body() d: PublishEncryptionPackageDto,
  ) {
    return this.service.publish(r.user.userId, 'AUDIT', d);
  }
  @Post('conversations/:id/events')
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('IM_READ')
  events(
    @Req() r: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: EncryptionEventsDto,
  ) {
    return this.service.events(r.user.userId, 'AUDIT', id, d);
  }
}
