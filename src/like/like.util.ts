/**
 * 把"今天"规整成 UTC 当天 0 点的 Date，用作 UserLike.likedOn（@db.Date）的值。
 * 这样「同一人对同一目标每天最多一条」的唯一约束按自然日（UTC）生效。
 */
export function likedOnToday(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}
