import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { createPublicKey, verify } from 'node:crypto';
import type { Prisma } from 'src/generated/prisma';
import { ADMIN_ROLE_PERMISSIONS } from 'src/admin-access/admin-permission.guard';

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

export async function requireAuditPermission(
  tx: Prisma.TransactionClient,
  userID: string,
) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userID} FOR SHARE`;
  await tx.$queryRaw`SELECT "userID" FROM "AdminAccess" WHERE "userID" = ${userID} FOR SHARE`;
  const user = await tx.user.findUnique({
    where: { id: userID },
    select: {
      role: true,
      status: true,
      adminAccess: { select: { role: true } },
    },
  });
  if (
    user?.role !== 'ADMIN' ||
    user.status !== 'ACTIVE' ||
    !(ADMIN_ROLE_PERMISSIONS[user.adminAccess?.role ?? ''] ?? []).includes(
      'IM_READ',
    )
  )
    throw new ForbiddenException('Administrator read access revoked');
}

// Called under the existing ChatConversation write lock. Device status locks
// order a send against device revocation; a stale MLS membership blocks sends
// until the manager commits removal and advances the epoch.
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
    include: {
      devices: { where: { removedEpoch: null }, include: { device: true } },
    },
  });
  if (!room || String(room.epoch) !== e.epoch)
    throw new ForbiddenException(
      'Encryption epoch changed; synchronize before sending',
    );
  await tx.$queryRaw`SELECT "id" FROM "E2eeDevice" WHERE "id" IN (SELECT "deviceID" FROM "E2eeRoomDevice" WHERE "conversationID" = ${conversationID} AND "removedEpoch" IS NULL) ORDER BY "id" FOR SHARE`;
  const devices = await tx.e2eeDevice.findMany({
    where: { id: { in: room.devices.map((seat) => seat.deviceID) } },
  });
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
  for (const device of audits) await requireAuditPermission(tx, device.userID);
  const owners = [
    ...new Set(
      devices
        .filter((device) => device.purpose === 'APP')
        .map((device) => device.userID),
    ),
  ];
  const seats = await tx.chatMember.count({
    where: { conversationID, userID: { in: owners }, leftAt: null },
  });
  const allSeats = await tx.chatMember.count({
    where: { conversationID, leftAt: null },
  });
  const activeOwners = await tx.user.count({
    where: { id: { in: owners }, status: 'ACTIVE' },
  });
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
