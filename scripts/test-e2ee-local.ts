// Run locally: npx ts-node -r tsconfig-paths/register scripts/test-e2ee-local.ts
// Uses only a loopback development database and deletes its own UUID-scoped fixtures.
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'dotenv';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Injectable, ValidationPipe } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { E2eeController, AdminE2eeController } from 'src/e2ee/e2ee.controller';
import { E2eeService } from 'src/e2ee/e2ee.service';
import { AdminPermissionGuard } from 'src/admin-access/admin-permission.guard';
import { ChatService } from 'src/chat/chat.service';

const env = {
  ...parse(readFileSync('.env')),
  ...(existsSync('.env.development')
    ? parse(readFileSync('.env.development'))
    : {}),
  ...process.env,
};
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(
    new URL(env.DATABASE_URL!).hostname,
  )
)
  throw Error('Loopback database required');
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const secret = randomBytes(32).toString('hex');
@Injectable()
class LocalStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: secret,
    });
  }
  validate(p: any) {
    return { userId: p.sub, role: p.role, audience: p.audience };
  }
}
const jwt = new JwtService({ secret });
const load = new Function('path', 'return import(path)');
const root = resolve(
  process.env.CIRCLE_E2EE_PACKAGE ?? '../circle-im/packages/e2ee',
);
const users = [randomUUID(), randomUUID(), randomUUID()];
const conversation = randomUUID();
const secondConversation = randomUUID();
let dropEpochReply = true;
const deviceIds: string[] = [];
let app: any;
let passed = 0;
const check = (message: string) => {
  passed++;
  console.log(`PASS ${message}`);
};
async function main() {
  const { ProtocolDevice } = await load(
    pathToFileURL(resolve(root, 'protocol.mjs')).href,
  );
  const { EncryptionClient } = await load(
    pathToFileURL(resolve(root, 'relay-client.mjs')).href,
  );
  const { sealJournal, openJournal } = await load(
    pathToFileURL(resolve(root, 'journal-codec.mjs')).href,
  );
  function journal(userId: string, deviceId: string) {
    const key = randomBytes(32);
    let revision = 0;
    let sealed: Uint8Array | null = null;
    return {
      async load() {
        return {
          revision,
          record: sealed
            ? openJournal(key, `${userId}:${deviceId}`, revision, sealed)
            : null,
        };
      },
      async save(expected: number, record: any) {
        assert.equal(expected, revision);
        sealed = sealJournal(key, `${userId}:${deviceId}`, ++revision, record);
      },
    };
  }
  const cryptoDevices = [];
  for (const userId of [users[0], users[1], users[2], users[1]]) {
    const id = randomUUID();
    deviceIds.push(id);
    cryptoDevices.push(
      await ProtocolDevice.open(journal(userId, id), userId, id, new Map()),
    );
  }
  for (let i = 0; i < users.length; i++)
    await db.user.create({
      data: {
        id: users[i],
        accountId: `e2ee-${users[i]}`,
        inviteCode: users[i],
        nickname: 'E2EE local fixture',
        passwordHash: 'disabled-test-password',
        role: i === 2 ? 'ADMIN' : 'USER',
        status: 'ACTIVE',
        ...(i === 2
          ? { adminAccess: { create: { role: 'SUPER_ADMIN' } } }
          : {}),
      },
    });
  await db.chatConversation.create({
    data: {
      id: conversation,
      type: 'DIRECT',
      directKey: users.slice(0, 2).sort().join(':'),
      members: { create: users.slice(0, 2).map((userID) => ({ userID })) },
    },
  });
  const module = await Test.createTestingModule({
    imports: [
      PassportModule,
      ThrottlerModule.forRoot([{ ttl: 60000, limit: 2000 }]),
    ],
    controllers: [E2eeController, AdminE2eeController],
    providers: [
      LocalStrategy,
      E2eeService,
      AdminPermissionGuard,
      { provide: PrismaService, useValue: db },
      {
        provide: ConfigService,
        useValue: new ConfigService({
          E2EE_TEXT_ENABLED: 'true',
          E2EE_AUDIT_ROOT_PUBLIC_KEY:
            cryptoDevices[2].publicIdentity().publicKey,
        }),
      },
    ],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  const transports: any[] = [];
  const clients = cryptoDevices.map((device, i) => {
    const audit = i === 2;
    const token = jwt.sign({
      sub: device.userId,
      role: audit ? 'ADMIN' : 'USER',
      audience: audit ? 'ADMIN' : 'APP',
    });
    const transport = async (path: string, method: string, body?: any) => {
      const response = await fetch(url + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      const result = await response.json();
      if (i === 0 && path.endsWith('/epochs') && dropEpochReply) {
        dropEpochReply = false;
        throw new Error('simulated lost epoch response');
      }
      return result;
    };
    transports.push(transport);
    return new EncryptionClient(
      device,
      transport,
      randomUUID,
      audit ? 'AUDIT' : 'APP',
    );
  });
  const [alice, bob, audit, bobNew] = clients;
  const rows = [];
  for (const [i, client] of clients.entries())
    rows.push(await client.register(`local-device-${i}`));
  assert.equal(rows[3].status, 'PENDING');
  await assert.rejects(bobNew.publish(), /403/);
  check('new device remains pending and cannot publish keys');
  await assert.rejects(transports[0]('/admin/e2ee/devices', 'GET'), /403/);
  await assert.rejects(transports[2]('/e2ee/devices', 'GET'), /403/);
  check('app/admin audiences cannot cross device APIs');
  await bob.trust([rows[3]]);
  await bob.deviceAction(rows[3], 'approve');
  await bobNew.publish();
  check('existing authorized device approves a new device with a signed proof');
  const directory = await alice.directory(conversation);
  for (const client of clients) await client.trust(directory.devices);
  await assert.rejects(alice.enable(conversation), /lost epoch response/);
  await alice.enable(conversation);
  assert.equal(
    await db.e2eeEpochEvent.count({ where: { conversationID: conversation } }),
    1,
  );
  check(
    'lost commit response resumes from durable intent without a second key rotation',
  );
  for (const client of [bob, audit, bobNew])
    await client.sync(
      conversation,
      client === audit ? 'local encryption verification' : undefined,
    );
  check(
    'App and administrator devices join the same MLS conversation via HTTP',
  );
  const chat = new ChatService(
    db as any,
    { check: () => ({ blocked: false }) } as any,
    {} as any,
    {
      attachMediaUrls: async () => {},
      attachNoteImportReferences: async () => {},
    } as any,
    { getSelfDestructPolicy: async () => ({ sec: 0 }) } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  const delivery = randomUUID();
  const text = `local-secret-${randomUUID()}`;
  const content = await alice.encrypt(conversation, delivery, { text });
  const result = await chat.sendMessage(users[0], {
    conversationId: conversation,
    type: 'encrypted-text',
    d: delivery,
    content,
  });
  const stored = await db.chatMessage.findUniqueOrThrow({
    where: { id: result.message.id },
  });
  assert.equal(JSON.stringify(stored).includes(text), false);
  assert.equal((await bob.decrypt(stored.content)).text, text);
  assert.equal(
    (await audit.decrypt(stored.content, 'local encryption verification')).text,
    text,
  );
  assert.equal((await bobNew.decrypt(stored.content)).text, text);
  assert.equal((await alice.decrypt(stored.content)).text, text);
  check(
    'real ChatService stores only ciphertext; all approved devices including admin decrypt',
  );
  const repeat = await chat.sendMessage(users[0], {
    conversationId: conversation,
    type: 'encrypted-text',
    d: delivery,
    content,
  });
  assert.equal(repeat.message.id, result.message.id);
  await assert.rejects(
    chat.sendMessage(users[0], {
      conversationId: conversation,
      type: 'text',
      d: randomUUID(),
      content: { text: 'must not be stored' },
    }),
  );
  await assert.rejects(
    chat.sendMessage(users[0], {
      conversationId: conversation,
      type: 'quote',
      d: randomUUID(),
      content: { text: 'must not be stored', quotedText: 'hidden plaintext' },
    }),
  );
  await assert.rejects(
    chat.sendMessage(users[1], {
      conversationId: conversation,
      type: 'encrypted-text',
      d: delivery,
      content,
    }),
  );
  check(
    'idempotent retry works; plaintext downgrade and sender impersonation are rejected',
  );
  await db.chatConversation.create({
    data: {
      id: secondConversation,
      type: 'GROUP',
      ownerID: users[0],
      membersCanViewRoster: true,
      members: { create: users.slice(0, 2).map((userID) => ({ userID })) },
    },
  });
  await alice.enable(secondConversation);
  for (const c of [bob, audit, bobNew])
    await c.sync(
      secondConversation,
      c === audit ? 'local second conversation verification' : undefined,
    );
  const secondId = randomUUID();
  const second = await alice.encrypt(secondConversation, secondId, {
    text: 'independent group conversation',
  });
  await chat.sendMessage(users[0], {
    conversationId: secondConversation,
    type: 'encrypted-text',
    d: secondId,
    content: second,
  });
  assert.equal(
    (await bob.decrypt(second)).text,
    'independent group conversation',
  );
  assert.equal(
    (await audit.decrypt(second, 'local second conversation verification'))
      .text,
    'independent group conversation',
  );
  check('one-time key packages work across a second group conversation');
  const code = await bob.createRecovery();
  assert.equal(await bob.createRecovery(), code);
  assert.equal(await bob.backupHistory(), 2);
  assert.equal(await bob.backupHistory(), 2);
  const recovery = await bob.recoveryInfo();
  const archiveRows = await db.e2eeArchive.findMany({
    where: { recoveryID: recovery.id },
  });
  assert.equal(archiveRows.length, 2);
  assert.equal(JSON.stringify(archiveRows).includes(text), false);
  check(
    'recovery setup retries safely and archives only ciphertext with message-bound deduplication',
  );
  await assert.rejects(
    transports[0]('/e2ee/archive/read', 'POST', {
      recoveryId: recovery.id,
      after: '',
      ...(await alice.signed('archive-read', [
        users[0],
        'APP',
        alice.device.deviceId,
        recovery.id,
        '',
        null,
      ])),
    }),
    /403/,
  );
  const forgedRecoveryPayload = [
    users[1],
    'APP',
    recovery.id,
    bobNew.device.deviceId,
    bobNew.device.publicIdentity().publicKey,
  ];
  await assert.rejects(
    transports[1]('/e2ee/recovery/restore', 'POST', {
      recoveryId: recovery.id,
      recoverySignature: await bobNew.device.signPayload(
        'recover',
        forgedRecoveryPayload,
      ),
      ...(await bobNew.signed('recover', forgedRecoveryPayload)),
    }),
    /403/,
  );
  check(
    'backend independently rejects another account archive and a forged recovery proof',
  );
  const freshId = randomUUID();
  deviceIds.push(freshId);
  const freshDevice = await ProtocolDevice.open(
    journal(users[1], freshId),
    users[1],
    freshId,
    new Map(),
  );
  const recovered = new EncryptionClient(
    freshDevice,
    transports[1],
    randomUUID,
  );
  assert.equal(
    (await recovered.register('local-recovered-phone')).status,
    'PENDING',
  );
  await assert.rejects(recovered.restoreHistory());
  await assert.rejects(
    recovered.recover(code.slice(0, -1) + (code.endsWith('0') ? '1' : '0')),
  );
  await assert.rejects(alice.recover(code));
  await recovered.recover(code);
  await recovered.recover(code);
  assert.notEqual(
    freshDevice.publicIdentity().publicKey,
    bob.device.publicIdentity().publicKey,
  );
  assert.deepEqual((await freshDevice.journal.load()).record.groups, {});
  const corrupted = archiveRows[0].ciphertext;
  await db.e2eeArchive.update({
    where: { id: archiveRows[0].id },
    data: {
      ciphertext: (corrupted[0] === 'A' ? 'B' : 'A') + corrupted.slice(1),
    },
  });
  await assert.rejects(recovered.restoreHistory());
  await db.e2eeArchive.update({
    where: { id: archiveRows[0].id },
    data: { ciphertext: corrupted },
  });
  check('tampered server archive cannot inject plaintext into the new device');
  assert.equal(await recovered.restoreHistory(), 2);
  assert.equal(await recovered.restoreHistory(), 2);
  assert.equal((await recovered.decrypt(content)).text, text);
  assert.equal(
    (await recovered.decrypt(second)).text,
    'independent group conversation',
  );
  check(
    'new identity recovers pre-join history without restoring old sending ratchets; wrong/cross-account codes fail',
  );
  const updatedDirectory = await alice.directory(conversation);
  for (const client of [...clients, recovered])
    await client.trust(updatedDirectory.devices);

  await bob.deviceAction(rows[3], 'revoke');
  await assert.rejects(bob.deviceAction(rows[3], 'approve'), /403/);
  await assert.rejects(bobNew.sync(conversation), /403/);
  await assert.rejects(
    alice.encrypt(conversation, randomUUID(), { text: 'blocked until rekey' }),
  );
  const staleId = randomUUID();
  const staleEnvelope = await alice.device.send(conversation, staleId, {
    text: 'stale epoch',
  });
  const stale = {
    envelope: staleEnvelope,
    signature: await alice.device.signPayload('send', [
      users[0],
      conversation,
      alice.device.deviceId,
      staleId,
      staleEnvelope.epoch,
      staleEnvelope.ciphertext,
    ]),
  };
  await assert.rejects(
    chat.sendMessage(users[0], {
      conversationId: conversation,
      type: 'encrypted-text',
      d: staleId,
      content: stale,
    }),
  );
  check(
    'revocation immediately blocks API access and sends using stale membership',
  );
  await alice.reconcile(conversation);
  const nextId = randomUUID();
  const next = await alice.encrypt(conversation, nextId, {
    text: 'after device removal',
  });
  await chat.sendMessage(users[0], {
    conversationId: conversation,
    type: 'encrypted-text',
    d: nextId,
    content: next,
  });
  assert.equal((await bob.decrypt(next)).text, 'after device removal');
  assert.equal(
    (await audit.decrypt(next, 'local encryption verification')).text,
    'after device removal',
  );
  await assert.rejects(bobNew.device.receive(next.envelope));
  check(
    'revoked device cannot decrypt new-epoch text even with a copied ciphertext',
  );

  await recovered.sync(conversation);
  assert.equal((await recovered.decrypt(next)).text, 'after device removal');
  const ownNewId = randomUUID();
  const ownNew = await recovered.encrypt(conversation, ownNewId, {
    text: 'recovered sender',
  });
  await chat.sendMessage(users[1], {
    conversationId: conversation,
    type: 'encrypted-text',
    d: ownNewId,
    content: ownNew,
  });
  assert.equal((await alice.decrypt(ownNew)).text, 'recovered sender');
  await assert.rejects(bobNew.recover(code), /403/);
  check(
    'recovered device joins a fresh epoch and sends; recovery never resurrects a revoked device',
  );
  await db.chatMessage.update({
    where: { id: result.message.id },
    data: { revokedAt: new Date(), content: {} },
  });
  await assert.rejects(recovered.decrypt(content), /no longer available/);
  assert.equal(
    await db.e2eeArchive.count({ where: { messageID: result.message.id } }),
    0,
  );
  const secondRow = await db.chatMessage.findFirstOrThrow({
    where: { conversationID: secondConversation, clientMessageId: secondId },
  });
  await db.chatMessage.update({
    where: { id: secondRow.id },
    data: { burnExpiresAt: new Date(Date.now() - 1000) },
  });
  await assert.rejects(recovered.decrypt(second), /no longer available/);
  // The new-epoch message was automatically archived; the two unavailable originals are omitted.
  assert.equal(await recovered.restoreHistory(), 1);
  check(
    'revoked and expired messages cannot be restored or read from local archives; server copies are purged',
  );
  await bob.backupHistory();
  await db.chatMember.update({
    where: {
      conversationID_userID: { conversationID: conversation, userID: users[1] },
    },
    data: { clearedBeforeHeight: 2147483647 },
  });
  await assert.rejects(recovered.decrypt(next), /no longer available/);
  assert.equal(
    await db.e2eeArchive.count({ where: { recoveryID: recovery.id } }),
    0,
  );
  check(
    'account clear watermarks remove encrypted backups and block cached history on a recovered device',
  );

  const aliceCode = await alice.createRecovery();
  const auditCode = await audit.createRecovery();
  assert(auditCode);
  await assert.rejects(audit.backupHistory(), /400/);
  assert((await audit.backupHistory('local archive acceptance')) >= 1);
  const aliceReplacementId = randomUUID();
  deviceIds.push(aliceReplacementId);
  const aliceReplacement = new EncryptionClient(
    await ProtocolDevice.open(
      journal(users[0], aliceReplacementId),
      users[0],
      aliceReplacementId,
      new Map(),
    ),
    transports[0],
    randomUUID,
  );
  await aliceReplacement.register('recovered-manager');
  await aliceReplacement.recover(aliceCode);
  await alice.deviceAction(rows[0], 'revoke');
  const takeoverDirectory = await audit.directory(conversation);
  for (const client of [audit, bob, recovered, aliceReplacement])
    await client.trust(takeoverDirectory.devices);
  await audit.reconcile(conversation);
  assert.equal(
    (
      await db.e2eeRoom.findUniqueOrThrow({
        where: { conversationID: conversation },
      })
    ).managerDeviceID,
    audit.device.deviceId,
  );
  await aliceReplacement.sync(conversation);
  const recoveredManagerId = randomUUID();
  const recoveredManagerMessage = await aliceReplacement.encrypt(
    conversation,
    recoveredManagerId,
    { text: 'manager device recovered' },
  );
  await chat.sendMessage(users[0], {
    conversationId: conversation,
    type: 'encrypted-text',
    d: recoveredManagerId,
    content: recoveredManagerMessage,
  });
  assert.equal(
    (await audit.decrypt(recoveredManagerMessage, 'local takeover acceptance'))
      .text,
    'manager device recovered',
  );
  check(
    'authorized surviving audit device replaces a revoked manager; recovered owner joins and sends with fresh keys',
  );
  await db.adminAccess.update({
    where: { userID: users[2] },
    data: { role: 'OPERATIONS' },
  });
  await assert.rejects(
    audit.decrypt(next, 'local encryption verification'),
    /403/,
  );
  check(
    'administrator permission revocation prevents further vault-backed reads',
  );
  const logs = await db.adminAuditLog.findMany({
    where: { actorID: users[2] },
  });
  assert(logs.length > 0);
  assert.equal(JSON.stringify(logs).includes(text), false);
  check(
    'administrator access is audited without message plaintext or private keys',
  );
  await db.adminAccess.update({
    where: { userID: users[2] },
    data: { role: 'SUPER_ADMIN' },
  });
  await audit.deviceAction(rows[2], 'revoke');
  const replacementId = randomUUID();
  const rootPublicKey = audit.device.publicIdentity().publicKey;
  await assert.rejects(
    transports[2]('/admin/e2ee/devices', 'POST', {
      deviceId: replacementId,
      publicKey: rootPublicKey,
      label: 'revocation bypass',
      signature: await audit.device.signPayload('register', [
        users[2],
        'AUDIT',
        replacementId,
        rootPublicKey,
        'revocation bypass',
      ]),
    }),
    /409/,
  );
  check(
    'revoked administrator root key cannot register again under a new device id',
  );
  console.log(`LOCAL_E2EE_OK checks=${passed}`);
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await app?.close();
    await db.chatConversation.deleteMany({
      where: { id: { in: [conversation, secondConversation] } },
    });
    await db.e2eeRecovery.deleteMany({ where: { userID: { in: users } } });
    await db.e2eeDevice.deleteMany({ where: { id: { in: deviceIds } } });
    await db.adminAuditLog.deleteMany({ where: { actorID: { in: users } } });
    // Registry rows reference users with RESTRICT, and users reference the registry.
    await db.accountIdentifier.updateMany({
      where: {
        OR: [
          { currentUserID: { in: users } },
          { reservedForUserID: { in: users } },
          { inviteOwnerUserID: { in: users } },
        ],
      },
      data: {
        currentUserID: null,
        reservedForUserID: null,
        inviteOwnerUserID: null,
      },
    });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.accountIdentifier.deleteMany({
      where: { value: { in: [...users, ...users.map((id) => `e2ee-${id}`)] } },
    });
    await db.$disconnect();
  });
