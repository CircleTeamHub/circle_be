import type { PrismaService } from 'src/prisma/prisma.service';

/** 永久删除前额外要满足的条件：主人本人删（立即删除）或到期（定时清理）。 */
export type NotePurgeGuard = { ownerID: string } | { deletedBefore: Date };

/**
 * 永久删除一条回收站里的笔记（status=DELETED）。回收站「立即删除」与 30 天到期
 * 清理共用，两边语义必须一致。
 *
 * 只删 Postgres 行（NoteMedia / NoteGroupMembership 随外键级联）；MinIO 对象留给
 * StorageAudit —— 收藏副本可能共用同一个 objectKey。
 *
 * 收录链：副本的 collectedFromNoteID 记的是**直接来源**，读取时沿链走到根取实时
 * 状态，查不到的来源按「已被永久删除」处理。所以删的若是链中间的一份副本，要先
 * 把它的下游改指向它的上游，链才不会断，下游也不会因为「中间那份没了」被误判成
 * 原文已删；删的是原文（没有上游）时下游照旧指着它，读取时判已删除，正是想要的。
 *
 * 改指向用原生 UPDATE：不能碰下游的 updatedAt —— 回收站 30 天计时就看它。
 * 若下游主人已经直接收藏过上游（「同人同源只能有一份活跃副本」唯一索引会拒绝），
 * 那一份不改指向：它仍会被判为来源已删，而这个人手里另有一份正常的副本。
 *
 * 返回是否真的删掉了（不在回收站 / 不满足条件 / 已被删时为 false）。
 */
export async function purgeDeletedNote(
  prisma: PrismaService,
  noteId: string,
  guard: NotePurgeGuard,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const [row] =
      'ownerID' in guard
        ? await tx.$queryRaw<Array<{ collectedFromNoteID: string | null }>>`
            SELECT "collectedFromNoteID" FROM "Note"
            WHERE "id" = ${noteId} AND "ownerID" = ${guard.ownerID}
              AND "status" = 'DELETED'
            FOR UPDATE`
        : await tx.$queryRaw<Array<{ collectedFromNoteID: string | null }>>`
            SELECT "collectedFromNoteID" FROM "Note"
            WHERE "id" = ${noteId} AND "status" = 'DELETED'
              AND "updatedAt" < ${guard.deletedBefore}
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
