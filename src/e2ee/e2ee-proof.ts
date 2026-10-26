import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { createPublicKey, verify } from 'node:crypto';
import type { Prisma } from 'src/generated/prisma';
import { ADMIN_ROLE_PERMISSIONS } from 'src/admin-access/admin-permission.guard';
import {
  type AuditAdminRow,
  encryptedSeatCountsQuery,
  type EncryptedSeatCounts,
  lockAuditAdminsQuery,
  lockRoomDevicesQuery,
} from './e2ee-lock.query';

export function verifyDeviceProof(
  publicKey: string,
  action: string,
  payload: unknown,
  signature: string,
) {
  try {
    if (
      !/^[A-Za-z0-9+/]{43}=$/.test(publicKey) ||
      !/^[A-Za-z0-9+/]{86}==$/.test(signature)
    )
      throw new Error();
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(publicKey, 'base64'),
      ]),
      format: 'der',
      type: 'spki',
    });
    if (
      !verify(
        null,
        Buffer.from(JSON.stringify(['circle-e2ee-action-v1', action, payload])),
        key,
        Buffer.from(signature, 'base64'),
      )
    )
      throw new Error();
  } catch {
    throw new ForbiddenException('Encryption device proof rejected');
  }
}

/**
 * 审计管理员此刻仍有 IM_READ(账号 ADMIN + ACTIVE + 后台角色含 IM_READ)。
 *
 * User / AdminAccess 行的 FOR SHARE 是刻意的:降权、封禁、删管理员都是对这两行的
 * 普通 UPDATE(FOR NO KEY UPDATE),与 FOR SHARE 冲突 —— 已提交的撤权之后,不能再有
 * 加密给该管理员审计设备的消息或归档访问按旧权限放行。不能换成 FOR KEY SHARE
 * (它不与普通 UPDATE 冲突)。原来每个审计设备三到四条语句(两次加锁、读权限及其
 * include),同一个管理员的多台设备还重复加锁;现在全部管理员一条语句加锁并读回。
 */
export async function requireAuditPermissions(
  tx: Prisma.TransactionClient,
  userIDs: string[],
) {
  const ids = [...new Set(userIDs)];
  if (!ids.length) return;
  const admins = new Map(
    (await tx.$queryRaw<AuditAdminRow[]>(lockAuditAdminsQuery(ids))).map(
      (row) => [row.id, row],
    ),
  );
  for (const id of ids) {
    const admin = admins.get(id);
    if (
      admin?.role !== 'ADMIN' ||
      admin.status !== 'ACTIVE' ||
      !(ADMIN_ROLE_PERMISSIONS[admin.adminRole] ?? []).includes('IM_READ')
    )
      throw new ForbiddenException('Administrator read access revoked');
  }
}

export async function requireAuditPermission(
  tx: Prisma.TransactionClient,
  userID: string,
) {
  await requireAuditPermissions(tx, [userID]);
}

type RoomDeviceRow = {
  id: string;
  userID: string;
  purpose: string;
  status: string;
  publicKey: string;
};

// Called under the existing ChatConversation write lock. Device status locks
// order a send against device revocation; a stale MLS membership blocks sends
// until the manager commits removal and advances the epoch.
//
// 房间成员与 epoch 的变更(E2eeService 的 commit/移除)都先取同一把会话行
// FOR UPDATE,所以锁下读到的房间设备集合与 epoch 是稳定的;设备状态与审计管理员
// 权限不归这把锁管,靠下面的 FOR SHARE 与吊销/降权排出先后(刻意的安全不变式,
// 保留)。原来锁内约 12 条语句:房间 + 设备 include 两层、设备 FOR SHARE 后再
// 读一遍设备、每个审计设备三四条、三次 count;现在 4 条。
export async function assertEncryptedTextSend(
  tx: Prisma.TransactionClient,
  userID: string,
  conversationID: string,
  type: string,
  clientMessageId: string,
  content: Record<string, unknown>,
) {
  if (type !== 'encrypted-text') {
    if (
      ['text', 'quote'].includes(type) ||
      'text' in content ||
      'quotedText' in content
    )
      throw new BadRequestException(
        'This conversation requires encrypted text',
      );
    return;
  }
  if (
    Object.keys(content).some((key) => !['envelope', 'signature'].includes(key))
  )
    throw new BadRequestException('Unexpected encrypted content fields');
  const e = content.envelope as Record<string, unknown> | undefined;
  if (
    !e ||
    Object.keys(e).some(
      (key) =>
        ![
          'version',
          'protocol',
          'conversationId',
          'senderDeviceId',
          'clientMessageId',
          'epoch',
          'ciphertext',
        ].includes(key),
    ) ||
    e.version !== 1 ||
    e.protocol !== 'mls10' ||
    e.conversationId !== conversationID ||
    e.clientMessageId !== clientMessageId ||
    typeof e.senderDeviceId !== 'string' ||
    typeof e.epoch !== 'string' ||
    !/^\d{1,10}$/.test(e.epoch) ||
    typeof e.ciphertext !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(e.ciphertext) ||
    typeof content.signature !== 'string'
  )
    throw new BadRequestException('Invalid encrypted text envelope');
  const room = await tx.e2eeRoom.findUnique({
    where: { conversationID },
    select: { epoch: true },
  });
  if (!room || String(room.epoch) !== e.epoch)
    throw new ForbiddenException(
      'Encryption epoch changed; synchronize before sending',
    );
  // 加锁与读设备合成一条:锁住的行读回的就是最新提交版本,不必锁完再读一遍。
  const devices = await tx.$queryRaw<RoomDeviceRow[]>(
    lockRoomDevicesQuery(conversationID),
  );
  if (devices.some((device) => device.status !== 'ACTIVE'))
    throw new ForbiddenException('Remove revoked devices before sending');
  const sender = devices.find(
    (device) =>
      device.id === e.senderDeviceId &&
      device.userID === userID &&
      device.purpose === 'APP',
  );
  if (!sender)
    throw new ForbiddenException('Encryption device is not an active sender');
  const audits = devices.filter((device) => device.purpose === 'AUDIT');
  if (!audits.length)
    throw new ForbiddenException('An authorized audit device must be included');
  await requireAuditPermissions(
    tx,
    audits.map((device) => device.userID),
  );
  const owners = [
    ...new Set(
      devices
        .filter((device) => device.purpose === 'APP')
        .map((device) => device.userID),
    ),
  ];
  const [{ seats, allSeats, activeOwners }] = await tx.$queryRaw<
    EncryptedSeatCounts[]
  >(encryptedSeatCountsQuery(conversationID, owners));
  if (
    seats !== owners.length ||
    allSeats !== owners.length ||
    activeOwners !== owners.length
  )
    throw new ForbiddenException(
      'Remove former conversation members before sending',
    );
  verifyDeviceProof(
    sender.publicKey,
    'send',
    [
      userID,
      conversationID,
      e.senderDeviceId,
      clientMessageId,
      e.epoch,
      e.ciphertext,
    ],
    content.signature,
  );
}
