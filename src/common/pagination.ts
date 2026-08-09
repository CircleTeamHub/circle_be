import { Injectable, type PipeTransform } from '@nestjs/common';

/**
 * 偏移翻页的页码上限。
 *
 * 每个列表 DTO 的 `limit` 都有 @Max（多为 100），但 `page` 长期只有 @Min(1)。
 * OFFSET 的代价与页码成正比而与返回行数无关：Postgres 必须先产出并丢弃
 * skip 之前的每一行，所以 `?page=100000000&limit=100` 会退化成一次全量扫描，
 * 返回却只有 100 行（甚至 0 行）。请求便宜、服务端昂贵，是典型的不对称成本。
 * 部分接口还会在偏移路径上无条件跑一次 count(*)，代价与页码无关地压在每次请求上。
 *
 * 500 页 × 每页最多 100 条 = 5 万行深度，任何真实 UI 都远远够用；再深的翻页本就
 * 应该走游标（plaza / trace 已经提供 nextCursor）。
 */
export const MAX_PAGE = 500;

/**
 * 给没有走 DTO 的 `@Query('page', ParseIntPipe)` 参数补同一道上限。
 *
 * 夹住而不是抛 400：这类参数本来就带 DefaultValuePipe，语义上是「尽力而为」的翻页，
 * 为一个越界页码返回错误只会让客户端更难处理。而 DTO 那边用 @Max 抛 400 是对的 ——
 * 那里页码是显式契约的一部分。
 */
@Injectable()
export class ClampPagePipe implements PipeTransform<number, number> {
  transform(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.min(Math.max(Math.trunc(value), 1), MAX_PAGE);
  }
}
