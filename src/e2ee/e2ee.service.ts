import { ADMIN_ROLE_PERMISSIONS } from 'src/admin-access/admin-permission.guard';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import type { Prisma } from 'src/generated/prisma';
import {
  EncryptionRecoverySetupDto,
  EncryptionRecoverDto,
  EncryptionMessageRefDto,
  EncryptionArchiveResolveDto,
  EncryptionArchiveWriteDto,
  EncryptionArchiveReadDto,
  EncryptionDeviceActionDto,
  EncryptionEpochDto,
  EncryptionEventsDto,
  PublishEncryptionPackageDto,
  RegisterEncryptionDeviceDto,
} from './e2ee.dto';
import { requireAuditPermission, verifyDeviceProof } from './e2ee-proof';

type Tx = Prisma.TransactionClient;
type Purpose = 'APP' | 'AUDIT';
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicDevice = {
  id: true,
  userID: true,
  purpose: true,
  publicKey: true,
  label: true,
  status: true,
  approvedByID: true,
  approvalSignature: true,
} as const;

@Injectable()
export class E2eeService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
  ) {}
  private enabled() {
    if (this.config.get<string>('E2EE_TEXT_ENABLED') !== 'true')
      throw new ForbiddenException('Text encryption is not enabled');
  }
  private async account(tx: Tx, userID: string, purpose: Purpose) {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userID} FOR SHARE`;
    const user = await tx.user.findUnique({
      where: { id: userID },
      select: { status: true },
    });
    if (user?.status !== 'ACTIVE') throw new ForbiddenException();
    if (purpose === 'AUDIT') {
      await tx.$queryRaw`SELECT "userID" FROM "AdminAccess" WHERE "userID" = ${userID} FOR SHARE`;
      await requireAuditPermission(tx, userID);
    }
  }
  private async actor(tx: Tx, userID: string, purpose: Purpose, id: string) {
    await this.account(tx, userID, purpose);
    await tx.$queryRaw`SELECT "id" FROM "E2eeDevice" WHERE "id" = ${id} FOR SHARE`;
    const actor = await tx.e2eeDevice.findUnique({ where: { id } });
    if (
      !actor ||
      actor.userID !== userID ||
      actor.purpose !== purpose ||
      actor.status !== 'ACTIVE'
    )
      throw new ForbiddenException('Device is not approved');
    return actor;
  }
  private async member(tx: Tx, userID: string, conversationID: string) {
    const seat = await tx.chatMember.findUnique({
      where: { conversationID_userID: { conversationID, userID } },
      include: { conversation: true },
    });
    if (
      !seat ||
      seat.leftAt ||
      !['DIRECT', 'GROUP'].includes(seat.conversation.type)
    )
      throw new ForbiddenException('Current conversation membership required');
    // MLS credentials expose membership. Do not defeat a hidden-roster policy.
    if (
      seat.conversation.type === 'GROUP' &&
      !seat.conversation.membersCanViewRoster
    )
      throw new ForbiddenException(
        'Encryption requires a visible member roster',
      );
    return seat;
  }
  async register(
    userID: string,
    purpose: Purpose,
    dto: RegisterEncryptionDeviceDto,
  ) {
    this.enabled();
    verifyDeviceProof(
      dto.publicKey,
      'register',
      [userID, purpose, dto.deviceId, dto.publicKey, dto.label],
      dto.signature,
    );
    return this.db.$transaction(async (tx) => {
      // Serialize first-device bootstrap, including a previously revoked history.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userID} FOR UPDATE`;
      await this.account(tx, userID, purpose);
      const existing = await tx.e2eeDevice.findUnique({
        where: { id: dto.deviceId },
      });
      if (existing) {
        if (
          existing.userID !== userID ||
          existing.purpose !== purpose ||
          existing.publicKey !== dto.publicKey
        )
          throw new ConflictException('Device identity cannot be replaced');
        return tx.e2eeDevice.findUnique({
          where: { id: existing.id },
          select: publicDevice,
        });
      }
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${dto.publicKey}, 0))`;
      if (
        await tx.e2eeDevice.findFirst({ where: { publicKey: dto.publicKey } })
      )
        throw new ConflictException(
          'A device key cannot be rebound to another identity',
        );
      const count = await tx.e2eeDevice.count({ where: { userID, purpose } });
      if (
        (await tx.e2eeDevice.count({
          where: { userID, purpose, status: { not: 'REVOKED' } },
        })) >= 32
      )
        throw new BadRequestException('Active device limit reached');
      const root = this.config.get<string>('E2EE_AUDIT_ROOT_PUBLIC_KEY');
      const active =
        purpose === 'APP'
          ? count === 0
          : Boolean(root && root === dto.publicKey);
      return tx.e2eeDevice.create({
        data: {
          id: dto.deviceId,
          userID,
          purpose,
          publicKey: dto.publicKey,
          label: dto.label,
          status: active ? 'ACTIVE' : 'PENDING',
        },
        select: publicDevice,
      });
    });
  }
  async devices(userID: string, purpose: Purpose) {
    return this.db.$transaction(async (tx) => {
      await this.account(tx, userID, purpose);
      return tx.e2eeDevice.findMany({
        where: { userID, purpose, status: { not: 'REVOKED' } },
        select: publicDevice,
        orderBy: { createdAt: 'asc' },
        take: 32,
      });
    });
  }
  async deviceAction(
    userID: string,
    purpose: Purpose,
    targetId: string,
    action: 'approve' | 'revoke',
    dto: EncryptionDeviceActionDto,
  ) {
    this.enabled();
    return this.db.$transaction(async (tx) => {
      // Stable lock order also handles two devices revoking each other.
      await tx.$queryRaw`SELECT "id" FROM "E2eeDevice" WHERE "id" IN (${targetId}, ${dto.actorDeviceId}) ORDER BY "id" FOR UPDATE`;
      const actor = await this.actor(tx, userID, purpose, dto.actorDeviceId);
      if (purpose === 'AUDIT') {
        const access = await tx.adminAccess.findUnique({
          where: { userID },
          select: { role: true },
        });
        if (
          !(ADMIN_ROLE_PERMISSIONS[access?.role ?? ''] ?? []).includes(
            'ACCESS_MANAGE',
          )
        )
          throw new ForbiddenException(
            'Administrator device management access revoked',
          );
      }
      const target = await tx.e2eeDevice.findUnique({
        where: { id: targetId },
      });
      if (!target || target.userID !== userID || target.purpose !== purpose)
        throw new ForbiddenException();
      verifyDeviceProof(
        actor.publicKey,
        action,
        [userID, purpose, targetId, target.publicKey, actor.id],
        dto.signature,
      );
      if (action === 'approve' && target.status === 'REVOKED')
        throw new ForbiddenException(
          'Revoked identities cannot be approved again',
        );
      const result = await tx.e2eeDevice.update({
        where: { id: targetId },
        data:
          action === 'approve'
            ? {
                status: 'ACTIVE',
                approvedByID: actor.id,
                approvalSignature: dto.signature,
              }
            : { status: 'REVOKED', revokedAt: new Date() },
        select: publicDevice,
      });
      if (action === 'revoke')
        await tx.e2eeKeyPackage.deleteMany({
          where: { deviceID: targetId, claimedBy: null },
        });
      if (purpose === 'AUDIT')
        await tx.adminAuditLog.create({
          data: {
            actorID: userID,
            action: `E2EE_DEVICE_${action.toUpperCase()}`,
            entityType: 'E2eeDevice',
            entityID: targetId,
          },
        });
      return result;
    });
  }
  async publish(
    userID: string,
    purpose: Purpose,
    dto: PublishEncryptionPackageDto,
  ) {
    this.enabled();
    return this.db.$transaction(async (tx) => {
      const actor = await this.actor(tx, userID, purpose, dto.actorDeviceId);
      verifyDeviceProof(
        actor.publicKey,
        'package',
        [userID, purpose, actor.id, dto.encoded],
        dto.signature,
      );
      const id = hash(dto.encoded);
      const existing = await tx.e2eeKeyPackage.findUnique({ where: { id } });
      if (existing) {
        if (existing.deviceID !== actor.id || existing.claimedBy)
          throw new ConflictException('Key package already consumed');
        return { id };
      }
      if (
        (await tx.e2eeKeyPackage.count({
          where: { deviceID: actor.id, claimedBy: null },
        })) >= 8
      )
        throw new BadRequestException('Unclaimed key package limit');
      await tx.e2eeKeyPackage.create({
        data: {
          id,
          deviceID: actor.id,
          encoded: dto.encoded,
          signature: dto.signature,
        },
      });
      return { id };
    });
  }
  async directory(
    userID: string,
    conversationID: string,
    purpose: Purpose = 'APP',
  ) {
    this.enabled();
    return this.db.$transaction(async (tx) => {
      await this.account(tx, userID, purpose);
      const conversation =
        purpose === 'APP'
          ? (await this.member(tx, userID, conversationID)).conversation
          : await tx.chatConversation.findUnique({
              where: { id: conversationID },
            });
      if (!conversation) throw new ForbiddenException();
      if (purpose === 'AUDIT')
        await tx.adminAuditLog.create({
          data: {
            actorID: userID,
            action: 'E2EE_DIRECTORY_READ',
            entityType: 'ChatConversation',
            entityID: conversationID,
          },
        });
      const members = await tx.chatMember.findMany({
        where: { conversationID, leftAt: null },
        select: { userID: true },
        take: 65,
      });
      if (members.length > 64)
        throw new BadRequestException(
          'This release supports at most 64 encrypted devices per conversation',
        );
      const devices = await tx.e2eeDevice.findMany({
        where: {
          status: 'ACTIVE',
          OR: [
            { purpose: 'APP', userID: { in: members.map((m) => m.userID) } },
            {
              purpose: 'AUDIT',
              user: {
                status: 'ACTIVE',
                role: 'ADMIN',
                adminAccess: {
                  role: {
                    in: Object.keys(ADMIN_ROLE_PERMISSIONS).filter((role) =>
                      ADMIN_ROLE_PERMISSIONS[role].includes('IM_READ'),
                    ),
                  },
                },
              },
            },
          ],
        },
        select: {
          ...publicDevice,
          packages: {
            where: { claimedBy: null },
            select: { id: true, encoded: true, signature: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
        take: 65,
      });
      if (devices.length > 64)
        throw new BadRequestException('Encrypted device limit reached');
      const authorizedDevices = [];
      for (const device of devices) {
        try {
          await this.account(tx, device.userID, device.purpose as Purpose);
          authorizedDevices.push(device);
        } catch (error) {
          // A removed administrator must disappear from the next MLS roster,
          // otherwise it would be impossible to remove their stale group leaf.
          if (
            device.purpose !== 'AUDIT' ||
            !(error instanceof ForbiddenException)
          )
            throw error;
        }
      }
      const room = await tx.e2eeRoom.findUnique({
        where: { conversationID },
        include: { devices: { where: { removedEpoch: null } } },
      });
      return {
        mode: conversation.textEncryption,
        members: members.map((m) => m.userID),
        devices: authorizedDevices,
        room,
      };
    });
  }
  async createRoom(
    userID: string,
    conversationID: string,
    dto: EncryptionDeviceActionDto,
  ) {
    this.enabled();
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ChatConversation" WHERE "id" = ${conversationID} FOR UPDATE`;
      const seat = await this.member(tx, userID, conversationID);
      if (seat.conversation.type === 'GROUP') {
        const owner = seat.conversation.circleID
          ? (
              await tx.circle.findUnique({
                where: { id: seat.conversation.circleID },
                select: { ownerID: true },
              })
            )?.ownerID
          : seat.conversation.ownerID;
        if (owner !== userID)
          throw new ForbiddenException('Group owner must enable encryption');
      }
      const actor = await this.actor(tx, userID, 'APP', dto.actorDeviceId);
      verifyDeviceProof(
        actor.publicKey,
        'create',
        [userID, conversationID, actor.id],
        dto.signature,
      );
      const existing = await tx.e2eeRoom.findUnique({
        where: { conversationID },
      });
      if (existing) {
        if (existing.managerDeviceID !== actor.id)
          throw new ConflictException(
            'Encryption already initialized by another device',
          );
        return existing;
      }
      const room = await tx.e2eeRoom.create({
        data: {
          conversationID,
          managerDeviceID: actor.id,
          devices: { create: { deviceID: actor.id, joinedEpoch: 0 } },
        },
      });
      // Irreversible downgrade barrier. Sending stays blocked until audit and peers join.
      await tx.chatConversation.update({
        where: { id: conversationID },
        data: { textEncryption: 'MLS_V1' },
      });
      return room;
    });
  }
  async epoch(
    userID: string,
    conversationID: string,
    dto: EncryptionEpochDto,
    purpose: Purpose = 'APP',
  ) {
    this.enabled();
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ChatConversation" WHERE "id" = ${conversationID} FOR UPDATE`;
      if (purpose === 'APP') await this.member(tx, userID, conversationID);
      const actor = await this.actor(tx, userID, purpose, dto.actorDeviceId);
      await this.recoveryAdmin(tx, userID, purpose);
      const room = await tx.e2eeRoom.findUnique({
        where: { conversationID },
        include: { devices: { where: { removedEpoch: null } } },
      });
      if (!room || room.managerDeviceID !== actor.id)
        throw new ForbiddenException(
          'Only the encryption manager may commit membership changes',
        );
      const payload = [
        userID,
        conversationID,
        actor.id,
        dto.operationId,
        dto.expectedEpoch,
        dto.packageIds,
        dto.removeDeviceIds,
        dto.commit,
        dto.welcome ?? null,
      ];
      verifyDeviceProof(actor.publicKey, 'epoch', payload, dto.signature);
      const requestHash = hash(payload);
      const old = await tx.e2eeEpochEvent.findUnique({
        where: { id: dto.operationId },
      });
      if (old) {
        if (old.requestHash !== requestHash)
          throw new ConflictException('Operation id reused');
        return { epoch: old.epoch };
      }
      if (room.epoch !== dto.expectedEpoch)
        throw new ConflictException('Encryption epoch changed');
      const packages = await tx.e2eeKeyPackage.findMany({
        where: { id: { in: dto.packageIds }, claimedBy: null },
        include: { device: true },
      });
      if (
        packages.length !== dto.packageIds.length ||
        (packages.length > 0 && !dto.welcome) ||
        dto.removeDeviceIds.includes(actor.id)
      )
        throw new BadRequestException('Invalid membership change');
      for (const kp of packages) {
        if (
          kp.device.status !== 'ACTIVE' ||
          room.devices.some((d) => d.deviceID === kp.deviceID)
        )
          throw new ForbiddenException('Invalid joining device');
        await this.account(tx, kp.device.userID, kp.device.purpose as Purpose);
        if (kp.device.purpose === 'APP')
          await this.member(tx, kp.device.userID, conversationID);
      }
      const retained = room.devices.filter(
        (d) => !dto.removeDeviceIds.includes(d.deviceID),
      );
      if (
        retained.length + packages.length > 64 ||
        new Set(packages.map((k) => k.deviceID)).size !== packages.length ||
        dto.removeDeviceIds.some(
          (id) => !room.devices.some((d) => d.deviceID === id),
        )
      )
        throw new BadRequestException('Invalid encrypted roster');
      const nextEpoch = room.epoch + 1;
      for (const id of dto.removeDeviceIds)
        await tx.e2eeRoomDevice.update({
          where: { conversationID_deviceID: { conversationID, deviceID: id } },
          data: { removedEpoch: nextEpoch },
        });
      for (const kp of packages) {
        const claimed = await tx.e2eeKeyPackage.updateMany({
          where: { id: kp.id, claimedBy: null },
          data: { claimedBy: conversationID },
        });
        if (claimed.count !== 1)
          throw new ConflictException('Key package already consumed');
        await tx.e2eeRoomDevice.upsert({
          where: {
            conversationID_deviceID: { conversationID, deviceID: kp.deviceID },
          },
          create: {
            conversationID,
            deviceID: kp.deviceID,
            joinedEpoch: nextEpoch,
          },
          update: { joinedEpoch: nextEpoch, removedEpoch: null },
        });
      }
      await tx.e2eeEpochEvent.create({
        data: {
          id: dto.operationId,
          conversationID,
          epoch: nextEpoch,
          requestHash,
          packet: {
            commit: dto.commit,
            welcome: dto.welcome ?? null,
            added: packages.map((k) => k.deviceID),
            removed: dto.removeDeviceIds,
            signature: dto.signature,
            payload,
          } as unknown as Prisma.InputJsonObject,
        },
      });
      await tx.e2eeRoom.update({
        where: { conversationID },
        data: { epoch: nextEpoch },
      });
      return { epoch: nextEpoch };
    });
  }
  async events(
    userID: string,
    purpose: Purpose,
    conversationID: string,
    dto: EncryptionEventsDto,
  ) {
    return this.db.$transaction(async (tx) => {
      const actor = await this.actor(tx, userID, purpose, dto.actorDeviceId);
      verifyDeviceProof(
        actor.publicKey,
        'events',
        [
          userID,
          purpose,
          conversationID,
          actor.id,
          dto.afterEpoch,
          dto.reason ?? null,
        ],
        dto.signature,
      );
      if (purpose === 'APP') await this.member(tx, userID, conversationID);
      else if (!dto.reason?.trim())
        throw new BadRequestException('Audit reason required');
      const seat = await tx.e2eeRoomDevice.findUnique({
        where: {
          conversationID_deviceID: { conversationID, deviceID: actor.id },
        },
        include: { room: true },
      });
      if (!seat || seat.removedEpoch !== null)
        throw new ForbiddenException(
          'Device is not in this encrypted conversation',
        );
      const events = await tx.e2eeEpochEvent.findMany({
        where: {
          conversationID,
          epoch: { gt: Math.max(dto.afterEpoch, seat.joinedEpoch - 1) },
        },
        orderBy: { epoch: 'asc' },
        take: 100,
      });
      const devices = await tx.e2eeDevice.findMany({
        where: { seats: { some: { conversationID } } },
        select: publicDevice,
        take: 256,
      });
      if (purpose === 'AUDIT')
        await tx.adminAuditLog.create({
          data: {
            actorID: userID,
            action: 'E2EE_EPOCH_READ',
            entityType: 'ChatConversation',
            entityID: conversationID,
            reason: dto.reason,
            metadata: {
              deviceId: actor.id,
              afterEpoch: dto.afterEpoch,
              count: events.length,
            },
          },
        });
      return {
        managerDeviceId: seat.room.managerDeviceID,
        epoch: seat.room.epoch,
        devices,
        events,
      };
    });
  }
  async takeover(
    userID: string,
    purpose: Purpose,
    conversationID: string,
    dto: EncryptionDeviceActionDto,
  ) {
    this.enabled();
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ChatConversation" WHERE "id"=${conversationID} FOR UPDATE`;
      const actor = await this.actor(tx, userID, purpose, dto.actorDeviceId);
      await this.recoveryAdmin(tx, userID, purpose);
      if (purpose === 'APP') await this.member(tx, userID, conversationID);
      verifyDeviceProof(
        actor.publicKey,
        'takeover',
        [userID, purpose, conversationID, actor.id],
        dto.signature,
      );
      const room = await tx.e2eeRoom.findUnique({ where: { conversationID } });
      const seat = await tx.e2eeRoomDevice.findUnique({
        where: {
          conversationID_deviceID: { conversationID, deviceID: actor.id },
        },
      });
      if (!room || !seat || seat.removedEpoch !== null)
        throw new ForbiddenException('A surviving group device is required');
      if (room.managerDeviceID === actor.id) return room;
      const old = await tx.e2eeDevice.findUnique({
        where: { id: room.managerDeviceID },
      });
      let usable = old?.status === 'ACTIVE';
      if (usable && old) {
        try {
          await this.account(tx, old.userID, old.purpose as Purpose);
          if (old.purpose === 'APP')
            await this.member(tx, old.userID, conversationID);
        } catch (error) {
          if (!(error instanceof ForbiddenException)) throw error;
          usable = false;
        }
      }
      if (usable)
        throw new ConflictException(
          'Revoke the lost manager device before takeover',
        );
      return tx.e2eeRoom.update({
        where: { conversationID },
        data: { managerDeviceID: actor.id },
      });
    });
  }
  async recoveryInfo(userID: string, purpose: Purpose) {
    return this.db.$transaction(async (tx) => {
      await this.account(tx, userID, purpose);
      const recovery = await tx.e2eeRecovery.findUnique({
        where: { userID_purpose: { userID, purpose } },
      });
      return { recovery };
    });
  }
  private async recoveryAdmin(tx: Tx, userID: string, purpose: Purpose) {
    if (purpose !== 'AUDIT') return;
    const access = await tx.adminAccess.findUnique({
      where: { userID },
      select: { role: true },
    });
    if (
      !(ADMIN_ROLE_PERMISSIONS[access?.role ?? ''] ?? []).includes(
        'ACCESS_MANAGE',
      )
    )
      throw new ForbiddenException(
        'Administrator device management access revoked',
      );
  }
  async setupRecovery(
    userID: string,
    purpose: Purpose,
    dto: EncryptionRecoverySetupDto,
  ) {
    this.enabled();
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${userID} FOR UPDATE`;
      const actor = await this.actor(tx, userID, purpose, dto.actorDeviceId);
      await this.recoveryAdmin(tx, userID, purpose);
      const payload = [
        userID,
        purpose,
        actor.id,
        dto.recoveryId,
        dto.publicKey,
      ];
      verifyDeviceProof(
        actor.publicKey,
        'recovery-setup',
        payload,
        dto.signature,
      );
      verifyDeviceProof(
        dto.publicKey,
        'recovery-setup',
        payload,
        dto.recoverySignature,
      );
      const existing = await tx.e2eeRecovery.findUnique({
        where: { userID_purpose: { userID, purpose } },
      });
      if (existing) {
        if (
          existing.id !== dto.recoveryId ||
          existing.publicKey !== dto.publicKey
        )
          throw new ConflictException(
            'Recovery already configured; use the existing recovery code',
          );
        return existing;
      }
      return tx.e2eeRecovery.create({
        data: { id: dto.recoveryId, userID, purpose, publicKey: dto.publicKey },
      });
    });
  }
  async recoverDevice(
    userID: string,
    purpose: Purpose,
    dto: EncryptionRecoverDto,
  ) {
    this.enabled();
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${userID} FOR UPDATE`;
      await this.account(tx, userID, purpose);
      await this.recoveryAdmin(tx, userID, purpose);
      await tx.$queryRaw`SELECT "id" FROM "E2eeDevice" WHERE "id"=${dto.actorDeviceId} FOR UPDATE`;
      const target = await tx.e2eeDevice.findUnique({
        where: { id: dto.actorDeviceId },
      });
      const recovery = await tx.e2eeRecovery.findUnique({
        where: { userID_purpose: { userID, purpose } },
      });
      if (
        !target ||
        target.userID !== userID ||
        target.purpose !== purpose ||
        target.status === 'REVOKED' ||
        recovery?.id !== dto.recoveryId
      )
        throw new ForbiddenException('Recovery rejected');
      const payload = [
        userID,
        purpose,
        recovery.id,
        target.id,
        target.publicKey,
      ];
      verifyDeviceProof(target.publicKey, 'recover', payload, dto.signature);
      verifyDeviceProof(
        recovery.publicKey,
        'recover',
        payload,
        dto.recoverySignature,
      );
      if (target.status === 'ACTIVE') return target;
      const result = await tx.e2eeDevice.update({
        where: { id: target.id },
        data: {
          status: 'ACTIVE',
          approvedByID: recovery.id,
          approvalSignature: dto.recoverySignature,
        },
        select: publicDevice,
      });
      if (purpose === 'AUDIT')
        await tx.adminAuditLog.create({
          data: {
            actorID: userID,
            action: 'E2EE_DEVICE_RECOVER',
            entityType: 'E2eeDevice',
            entityID: target.id,
          },
        });
      return result;
    });
  }
  private ref(ref: EncryptionMessageRefDto) {
    return [ref.conversationId, ref.senderDeviceId, ref.clientMessageId];
  }
  private async archiveActor(
    tx: Tx,
    userID: string,
    purpose: Purpose,
    dto: EncryptionDeviceActionDto & { reason?: string },
    action: string,
    values: unknown[],
  ) {
    const actor = await this.actor(tx, userID, purpose, dto.actorDeviceId);
    if (purpose === 'AUDIT' && !dto.reason?.trim())
      throw new BadRequestException('Audit reason required');
    verifyDeviceProof(
      actor.publicKey,
      action,
      [userID, purpose, actor.id, ...values, dto.reason ?? null],
      dto.signature,
    );
    if (purpose === 'AUDIT')
      await tx.adminAuditLog.create({
        data: {
          actorID: userID,
          action: 'E2EE_ARCHIVE_ACCESS',
          entityType: 'E2eeDevice',
          entityID: actor.id,
          reason: dto.reason,
        },
      });
  }
  private async visibleArchiveMessage(
    tx: Tx,
    userID: string,
    purpose: Purpose,
    ref: EncryptionMessageRefDto,
  ) {
    // Lock the conversation so clear/remove/send cannot race an archive write.
    await tx.$queryRaw`SELECT "id" FROM "ChatConversation" WHERE "id"=${ref.conversationId} FOR SHARE`;
    const sender = await tx.e2eeDevice.findUnique({
      where: { id: ref.senderDeviceId },
    });
    if (!sender) return null;
    const message = await tx.chatMessage.findFirst({
      where: {
        conversationID: ref.conversationId,
        senderID: sender.userID,
        clientMessageId: ref.clientMessageId,
        type: 'encrypted-text',
        deleted: false,
        revokedAt: null,
        OR: [{ burnExpiresAt: null }, { burnExpiresAt: { gt: new Date() } }],
      },
      include: { conversation: true },
    });
    if (!message || message.height <= message.conversation.clearedBeforeHeight)
      return null;
    if (purpose === 'APP') {
      await tx.$queryRaw`SELECT "id" FROM "ChatMember" WHERE "conversationID"=${ref.conversationId} AND "userID"=${userID} FOR SHARE`;
      const member = await tx.chatMember.findUnique({
        where: {
          conversationID_userID: { conversationID: ref.conversationId, userID },
        },
      });
      if (
        !member ||
        member.leftAt ||
        message.height <= member.clearedBeforeHeight
      )
        return null;
    }
    const content = message.content as {
      envelope?: { senderDeviceId?: string };
    };
    if (content?.envelope?.senderDeviceId !== ref.senderDeviceId) return null;
    return message;
  }
  async resolveArchive(
    userID: string,
    purpose: Purpose,
    dto: EncryptionArchiveResolveDto,
  ) {
    return this.db.$transaction(async (tx) => {
      await this.archiveActor(tx, userID, purpose, dto, 'archive-resolve', [
        dto.refs.map((ref) => this.ref(ref)),
      ]);
      const items = [];
      for (const ref of [...dto.refs].sort((a, b) =>
        a.conversationId.localeCompare(b.conversationId),
      )) {
        const m = await this.visibleArchiveMessage(tx, userID, purpose, ref);
        if (m)
          items.push({
            messageID: m.id,
            ref: this.ref(ref),
            content: m.content,
            expiresAt: m.burnExpiresAt?.toISOString() ?? null,
          });
      }
      const archived = await tx.e2eeArchive.findMany({
        where: {
          recovery: { userID, purpose },
          messageID: { in: items.map((item) => item.messageID) },
        },
        select: { messageID: true },
      });
      const archivedIds = new Set(archived.map((item) => item.messageID));
      return {
        items: items.map(({ messageID, ...item }) => ({
          messageID,
          ...item,
          archived: archivedIds.has(messageID),
        })),
      };
    });
  }
  async writeArchive(
    userID: string,
    purpose: Purpose,
    dto: EncryptionArchiveWriteDto,
  ) {
    return this.db.$transaction(async (tx) => {
      await this.archiveActor(tx, userID, purpose, dto, 'archive-write', [
        dto.recoveryId,
        dto.items.map((item) => [...this.ref(item), item.ciphertext]),
      ]);
      const recovery = await tx.e2eeRecovery.findUnique({
        where: { userID_purpose: { userID, purpose } },
      });
      if (recovery?.id !== dto.recoveryId) throw new ForbiddenException();
      verifyDeviceProof(
        recovery.publicKey,
        'archive-write',
        [
          userID,
          purpose,
          dto.actorDeviceId,
          dto.recoveryId,
          dto.items.map((item) => [...this.ref(item), item.ciphertext]),
          dto.reason ?? null,
        ],
        dto.recoverySignature,
      );
      // Serialize inserts per recovery so cursor allocation also follows commit
      // order across devices; a late commit must not appear behind a read cursor.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('e2ee-archive'), hashtext(${recovery.id}))`;
      let count = 0;
      for (const item of [...dto.items].sort((a, b) =>
        a.conversationId.localeCompare(b.conversationId),
      )) {
        const m = await this.visibleArchiveMessage(tx, userID, purpose, item);
        if (!m) continue;
        // Row lock orders this insert against revoke/burn triggers.
        await tx.$queryRaw`SELECT "id" FROM "ChatMessage" WHERE "id"=${m.id} AND NOT "deleted" AND "revokedAt" IS NULL FOR SHARE`;
        const current = await tx.chatMessage.findUnique({
          where: { id: m.id },
          select: { deleted: true, revokedAt: true },
        });
        if (!current || current.deleted || current.revokedAt) continue;
        await tx.e2eeArchive.upsert({
          where: {
            recoveryID_messageID: { recoveryID: recovery.id, messageID: m.id },
          },
          create: {
            id: hash([recovery.id, m.id]),
            recoveryID: recovery.id,
            messageID: m.id,
            ciphertext: item.ciphertext,
          },
          update: {},
        });
        count++;
      }
      return { count };
    });
  }
  async readArchive(
    userID: string,
    purpose: Purpose,
    dto: EncryptionArchiveReadDto,
  ) {
    return this.db.$transaction(async (tx) => {
      await this.archiveActor(tx, userID, purpose, dto, 'archive-read', [
        dto.recoveryId,
        dto.after,
      ]);
      const recovery = await tx.e2eeRecovery.findUnique({
        where: { userID_purpose: { userID, purpose } },
      });
      if (recovery?.id !== dto.recoveryId) throw new ForbiddenException();
      const after = dto.after.startsWith('v1:')
        ? BigInt(dto.after.slice(3))
        : dto.after
          ? (
              await tx.e2eeArchive.findFirst({
                where: { recoveryID: recovery.id, id: dto.after },
                select: { cursor: true },
              })
            )?.cursor
          : BigInt(0);
      if (after === undefined)
        throw new BadRequestException('Invalid archive cursor');
      const rows = await tx.e2eeArchive.findMany({
        where: { recoveryID: recovery.id, cursor: { gt: after } },
        orderBy: { cursor: 'asc' },
        take: 20,
        include: {
          message: { select: { content: true, burnExpiresAt: true } },
        },
      });
      const items = [];
      for (const row of rows) {
        const content = row.message.content as {
          envelope?: EncryptionMessageRefDto;
        };
        if (
          content.envelope &&
          (await this.visibleArchiveMessage(
            tx,
            userID,
            purpose,
            content.envelope,
          ))
        )
          items.push({
            id: row.id,
            messageID: row.messageID,
            expiresAt:
              (
                row.message as { burnExpiresAt?: Date }
              ).burnExpiresAt?.toISOString() ?? null,
            ref: this.ref(content.envelope),
            ciphertext: row.ciphertext,
            content: row.message.content,
          });
        else await tx.e2eeArchive.delete({ where: { id: row.id } });
      }
      return {
        items,
        next:
          rows.length === 20
            ? `v1:${rows[rows.length - 1].cursor.toString().padStart(20, '0')}`
            : null,
      };
    });
  }
}
