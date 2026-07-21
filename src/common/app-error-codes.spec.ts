import {
  APP_ERROR_CODES,
  AuthErrorCode,
  CallErrorCode,
  ChatHistoryErrorCode,
  CircleErrorCode,
  CircleInvitationErrorCode,
  CoinErrorCode,
  CollectionErrorCode,
  ConversationGroupErrorCode,
  FriendErrorCode,
  GroupErrorCode,
  IconErrorCode,
  LikeErrorCode,
  MembershipErrorCode,
  NoteErrorCode,
  PlazaErrorCode,
  PrivacyErrorCode,
  TempChatErrorCode,
  TraceErrorCode,
  UploadErrorCode,
  UserErrorCode,
} from './app-error-codes';

// These codes are a stable contract shared with the frontend i18n map
// (serverErrors.<code>). Two guarantees matter:
//   1. Every code string is globally unique — a duplicate value would make two
//      distinct backend errors collapse onto the same localized copy.
//   2. Codes follow the SCREAMING_SNAKE_CASE convention the frontend keys on,
//      so a stray lowercase / typo'd value fails loudly here instead of
//      silently falling back to the raw (often Chinese) backend message.
describe('app error code catalog', () => {
  const groups = {
    AuthErrorCode,
    CoinErrorCode,
    MembershipErrorCode,
    CircleErrorCode,
    GroupErrorCode,
    CircleInvitationErrorCode,
    TempChatErrorCode,
    PlazaErrorCode,
    TraceErrorCode,
    FriendErrorCode,
    NoteErrorCode,
    CallErrorCode,
    UploadErrorCode,
    ConversationGroupErrorCode,
    ChatHistoryErrorCode,
    CollectionErrorCode,
    IconErrorCode,
    LikeErrorCode,
    PrivacyErrorCode,
    UserErrorCode,
  } as const;

  const allEntries = Object.entries(groups).flatMap(([group, codes]) =>
    Object.entries(codes).map(([key, value]) => ({ group, key, value })),
  );

  it('has globally unique code values across every group', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { group, key, value } of allEntries) {
      const prior = seen.get(value);
      if (prior) {
        collisions.push(`${value} used by both ${prior} and ${group}.${key}`);
      } else {
        seen.set(value, `${group}.${key}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('uses SCREAMING_SNAKE_CASE for every code value', () => {
    const invalid = allEntries
      .filter(({ value }) => !/^[A-Z]+(?:_[A-Z0-9]+)*$/.test(value))
      .map(({ group, key, value }) => `${group}.${key}=${value}`);
    expect(invalid).toEqual([]);
  });

  it('exports the canonical flat frontend contract in group order', () => {
    expect(APP_ERROR_CODES).toEqual(allEntries.map(({ value }) => value));
  });
});
