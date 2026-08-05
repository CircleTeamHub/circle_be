/**
 * Maximum number of non-deleted circles a user may create.
 *
 * Owned circles do not consume the tiered joined-circle quota in
 * MEMBERSHIP_CATALOG, so creation keeps an independent finite limit.
 */
export const CIRCLE_CREATE_LIMIT = 20;
