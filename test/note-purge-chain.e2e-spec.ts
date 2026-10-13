import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { NoteService } from 'src/note/note.service';
import { purgeDeletedNote } from 'src/note/note-purge';
import { getE2eApp } from './e2e-context';

const canRun =
  process.env.NODE_ENV === 'test' &&
  Boolean(process.env.SECRET) &&
  /(^|[_-])test($|[_-])/i.test(
    new URL(
      process.env.DATABASE_URL || 'postgresql://localhost/disabled',
    ).pathname.slice(1),
  );
const describeDatabase = canRun ? describe : describe.skip;

// 收录链 A（原文）→ B（B 收藏 A）→ C（C 收藏 B）。副本的 collectedFromNoteID 记的是
// 直接来源，读取时沿链取根的实时状态；查不到的来源按「已被永久删除」处理。
describeDatabase('Permanent delete keeps collected-copy chains intact', () => {
  // 应用由 e2e setup 在各用例前就绪；与其它 e2e 一样在用例里取。
  let prisma: PrismaService;
  let notes: NoteService;

  beforeEach(() => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    notes = app.get(NoteService);
  });

  async function user() {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    return prisma.user.create({
      data: {
        accountId: `purge-${suffix}`,
        inviteCode: suffix.slice(0, 6),
        passwordHash: 'unused',
        nickname: 'Purge test',
      },
    });
  }

  async function note(ownerID: string, collectedFromNoteID: string | null) {
    return prisma.note.create({
      data: {
        ownerID,
        title: 'Chain',
        status: 'ACTIVE',
        available: true,
        collectedFromNoteID,
      },
    });
  }

  async function chain() {
    const [a, b, c, stranger] = await Promise.all([
      user(),
      user(),
      user(),
      user(),
    ]);
    const root = await note(a.id, null);
    const relay = await note(b.id, root.id);
    const leaf = await note(c.id, relay.id);
    return { a, b, c, stranger, root, relay, leaf };
  }

  it('purging a middle copy re-points its downstream copy and keeps it readable', async () => {
    const { b, stranger, root, relay, leaf } = await chain();
    await prisma.note.update({
      where: { id: relay.id },
      data: { status: 'DELETED' },
    });
    const before = await prisma.note.findUniqueOrThrow({
      where: { id: leaf.id },
    });

    await expect(
      purgeDeletedNote(prisma, relay.id, { ownerID: b.id }),
    ).resolves.toBe(true);

    const after = await prisma.note.findUniqueOrThrow({
      where: { id: leaf.id },
    });
    expect(after.collectedFromNoteID).toBe(root.id);
    // 改指向不能给下游续命：回收站 30 天计时看的就是 updatedAt。
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    // 原文还在上架：第三人照样能读这份副本。
    await expect(notes.getNote(stranger.id, leaf.id)).resolves.toMatchObject({
      id: leaf.id,
    });
  });

  it('purging the original blocks every downstream copy for other viewers', async () => {
    const { a, c, stranger, root, leaf } = await chain();
    await prisma.note.update({
      where: { id: root.id },
      data: { status: 'DELETED' },
    });

    await expect(
      purgeDeletedNote(prisma, root.id, { ownerID: a.id }),
    ).resolves.toBe(true);

    await expect(notes.getNote(stranger.id, leaf.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // 副本主人自己仍能打开，并看到来源已删除。
    await expect(notes.getNote(c.id, leaf.id)).resolves.toMatchObject({
      status: 'DELETED',
    });
  });

  it('leaves a downstream copy alone when its owner already holds a direct copy of the upstream', async () => {
    const { b, c, root, relay, leaf } = await chain();
    // C 另外直接收藏过原文：再把 leaf 改指向原文会撞「同人同源唯一」索引。
    await note(c.id, root.id);
    await prisma.note.update({
      where: { id: relay.id },
      data: { status: 'DELETED' },
    });

    await expect(
      purgeDeletedNote(prisma, relay.id, { ownerID: b.id }),
    ).resolves.toBe(true);

    const after = await prisma.note.findUniqueOrThrow({
      where: { id: leaf.id },
    });
    expect(after.collectedFromNoteID).toBe(relay.id);
  });

  it('only purges notes that are in the recycle bin of the caller', async () => {
    const { b, c, relay } = await chain();
    // 还没删进回收站。
    await expect(
      purgeDeletedNote(prisma, relay.id, { ownerID: b.id }),
    ).resolves.toBe(false);
    await prisma.note.update({
      where: { id: relay.id },
      data: { status: 'DELETED' },
    });
    // 别人的回收站。
    await expect(
      purgeDeletedNote(prisma, relay.id, { ownerID: c.id }),
    ).resolves.toBe(false);
    await expect(
      prisma.note.findUnique({ where: { id: relay.id } }),
    ).resolves.not.toBeNull();
  });
});
