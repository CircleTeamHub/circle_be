/**
 * 圈子数量上限。两条上限都与会员档位无关 —— 所有档位同一数值。
 *
 * MEMBERSHIP_CATALOG 里的 `joinedCircles` 只用于会员中心展示，不参与执行；
 * circle-limits.spec.ts 断言两者一致，避免改了目录却没改执行（或反过来）。
 */

/**
 * 一个用户最多能加入的圈子数：只统计 ACTIVE 且 role != OWNER 的成员关系。
 * 自己创建的圈子由 CIRCLE_CREATE_LIMIT 管，不占这条额度。
 */
export const CIRCLE_JOIN_LIMIT = 100;

/**
 * 一个用户最多能创建的圈子数（未删除的）。
 *
 * 建圈不占加入额度，所以必须有独立上限：否则任何有效会员都能无限建圈，
 * 而每个圈子还会连带创建一个 OpenIM 群，是可被滥用的无界写入路径。
 */
export const CIRCLE_CREATE_LIMIT = 20;
