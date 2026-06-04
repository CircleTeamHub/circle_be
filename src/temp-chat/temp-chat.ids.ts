import { randomUUID } from 'crypto';

/** OpenIM 不接受连字符，统一去掉。 */
const raw = (): string => randomUUID().replace(/-/g, '');

export const newGroupId = (): string => `tmp${raw()}`;
export const newGuestId = (): string => `g${raw()}`;
