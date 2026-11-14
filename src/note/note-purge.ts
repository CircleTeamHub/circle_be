import type { PrismaService } from 'src/prisma/prisma.service';

/**
 * 物理删除一条已删除（status=DELETED）的笔记：主人删除、下架满 60 天都先标成 DELETED，
 * 再由 NoteCleanup 逐条调这里。
 *
 * 只删 Postgres 行（NoteMedia / NoteGroupMembership 随外键级联）；MinIO 对象留给
 * StorageAudit —— 收藏副本可能共用同一个 objectKey。
 *
 * 收录链：副本的 collectedFromNoteID 记的是**直接来源**，读取时沿链走到根取实时
 * 状态，查不到的来源按「已被永久删除」处理。所以删的若是链中间的一份副本，要先
 * 把它的下游改指向它的上游，链才不会断，下游也不会因为「中间那份没了」被误判成
 * 原文已删；删的是原文（没有上游）时下游照旧指着它，读取时判已删除，正是想要的。
 *
 * 改指向用原生 UPDATE：只修收录链，不算编辑，不碰下游的 updatedAt / unlistedAt。
 * 若下游主人已经直接收藏过上游（「同人同源只能有一份活跃副本」唯一索引会拒绝），
 * 那一份不改指向：它仍会被判为来源已删，而这个人手里另有一份正常的副本。
 *
 * 返回是否真的删掉了（不是 DELETED / 已被删时为 false）。
 */
export async function purgeDeletedNote(
  prisma: PrismaService,
  noteId: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<
      Array<{ collectedFromNoteID: string | null }>
    >`
      SELECT "collectedFromNoteID" FROM "Note"
      WHERE "id" = ${noteId} AND "status" = 'DELETED'
      FOR UPDATE`;
    if (!row) return false;

    const parentID = row.collectedFromNoteID;
    if (parentID) {
      await tx.$executeRaw`
        UPDATE "Note" AS child
        SET "collectedFromNoteID" = ${parentID}
        WHERE child."collectedFromNoteID" = ${noteId}
          AND (
            child."status" = 'DELETED'
            OR NOT EXISTS (
              SELECT 1 FROM "Note" AS dup
              WHERE dup."ownerID" = child."ownerID"
                AND dup."collectedFromNoteID" = ${parentID}
                AND dup."status" <> 'DELETED'
                AND dup."id" <> child."id"
            )
          )`;
    }

    const removed = await tx.note.deleteMany({
      where: { id: noteId, status: 'DELETED' },
    });
    return removed.count > 0;
  });
}
