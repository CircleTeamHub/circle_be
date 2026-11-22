import type { PrismaService } from 'src/prisma/prisma.service';
import { purgeDeletedNote } from './note-purge';

function fakePrisma(purgeable: boolean) {
  const order: string[] = [];
  const tx = {
    $queryRaw: jest.fn(async () =>
      purgeable ? [{ collectedFromNoteID: null }] : [],
    ),
    $executeRaw: jest.fn(async () => 0),
    noteDraft: {
      deleteMany: jest.fn(async () => {
        order.push('drafts');
        return { count: 1 };
      }),
    },
    note: {
      deleteMany: jest.fn(async () => {
        order.push('note');
        return { count: 1 };
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { prisma, tx, order };
}

describe('purgeDeletedNote', () => {
  // 编辑已有笔记只能存回原笔记：原笔记永久删除后，没存的编辑草稿不能被当成新笔记发出来。
  it('deletes the note’s unsaved edit drafts before the note, so they can never come back as a new note', async () => {
    const { prisma, tx, order } = fakePrisma(true);

    await expect(
      purgeDeletedNote(prisma, 'note-1', { ownerID: 'owner-1' }),
    ).resolves.toBe(true);

    expect(tx.noteDraft.deleteMany).toHaveBeenCalledWith({
      where: { sourceNoteID: 'note-1', consumedAt: null },
    });
    // 先删草稿：笔记一删，外键 SetNull 会把草稿的 sourceNoteID 清空，就再也认不出来了。
    expect(order).toEqual(['drafts', 'note']);
  });

  it('leaves drafts alone when the note is not in the recycle bin', async () => {
    const { prisma, tx } = fakePrisma(false);

    await expect(
      purgeDeletedNote(prisma, 'note-1', { ownerID: 'owner-1' }),
    ).resolves.toBe(false);

    expect(tx.noteDraft.deleteMany).not.toHaveBeenCalled();
    expect(tx.note.deleteMany).not.toHaveBeenCalled();
  });
});
