import { BadRequestException } from '@nestjs/common';

/**
 * Opaque keyset cursor for feeds ordered by `(createdAt DESC, id DESC)`.
 * Base64url of `<iso8601>|<uuid>`; opaque to clients so the internal ordering
 * can change without breaking their stored cursors. Shared by the trace and
 * circle-plaza feeds — both paginate on the same tuple.
 */
export type FeedCursor = { createdAt: Date; id: string };

export function encodeFeedCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * Decode a cursor or throw 400 with the caller's stable errorCode (each feed
 * keeps its own `*_INVALID_CURSOR` code for client-side i18n mapping).
 */
export function decodeFeedCursor(cursor: string, errorCode: string): FeedCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw invalidCursor(errorCode);
  }
  // Split on the LAST separator: an ISO timestamp never contains `|`, and this
  // stays correct even if a future id form ever did.
  const sep = decoded.lastIndexOf('|');
  const iso = sep > 0 ? decoded.slice(0, sep) : '';
  const id = sep > 0 ? decoded.slice(sep + 1) : '';
  const createdAt = new Date(iso);
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw invalidCursor(errorCode);
  }
  return { createdAt, id };
}

function invalidCursor(errorCode: string): BadRequestException {
  return new BadRequestException({
    message: 'Invalid feed cursor',
    errorCode,
  });
}

/**
 * Keyset predicate for Prisma: rows strictly "older" than the cursor under the
 * `(createdAt DESC, id DESC)` ordering. `id` is the tiebreaker so rows sharing
 * a timestamp are never skipped or repeated across pages.
 */
export function feedCursorWhere(cursor: FeedCursor): {
  OR: [
    { createdAt: { lt: Date } },
    { createdAt: Date; id: { lt: string } },
  ];
} {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}
