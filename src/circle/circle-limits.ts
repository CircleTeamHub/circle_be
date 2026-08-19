/**
 * Maximum number of non-deleted circles a user may create.
 *
 * Owned circles do not consume the tiered joined-circle quota in
 * MEMBERSHIP_CATALOG, so creation keeps an independent finite limit.
 */
export const CIRCLE_CREATE_LIMIT = 20;

/**
 * Hard ceiling on a circle's stored member capacity.
 *
 * `Circle.maxMembers` is an int4 column, and on create it defaults straight to
 * the creator's membership quota — the client never sends the field. That makes
 * MEMBERSHIP_CATALOG, which is data rather than validated input, the de-facto
 * bound on a database column. A quota written too large (or, as briefly
 * happened, set to Number.MAX_SAFE_INTEGER while the paid rollout was off)
 * would not be a policy rejection but a numeric-overflow 500 at insert.
 *
 * Clamping here keeps capacity a product decision instead of a range error.
 * The expansion path has always applied this same ceiling; both now read it
 * from one place so they cannot drift apart.
 */
export const GROUP_CAPACITY_HARD_LIMIT = 3000;
