// Product rules for note ratings (docs/note-rating.md). Days and months are
// Asia/Shanghai calendar days and months.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Raters below this credit score lose rating rights. New users start at 100. */
export const NOTE_RATING_MIN_CREDIT = 90;
/** Accounts younger than this cannot rate. */
export const NOTE_RATING_MIN_ACCOUNT_AGE_MS = 7 * DAY_MS;
/** Same rater, same note: one rating per rolling window. */
export const NOTE_RATING_NOTE_COOLDOWN_MS = 72 * HOUR_MS;
/** Counted ratings one note may receive per day, per value (5 good + 5 bad). */
export const NOTE_RATING_NOTE_DAILY_CAP = 5;
/** Burst detection: this many same-value ratings for one owner inside the window. */
export const NOTE_RATING_BURST_WINDOW_MS = 10 * 60 * 1000;
export const NOTE_RATING_BURST_THRESHOLD = 3;
/** Appeals an owner may file per calendar month. */
export const NOTE_RATING_APPEALS_PER_MONTH = 5;
/** Credit deducted from a rater for each rating an admin confirms as abuse. */
export const NOTE_RATING_ABUSE_CREDIT_DEDUCTION = 15;
export const NOTE_RATING_COMMENT_MAX = 200;
export const NOTE_RATING_APPEAL_REASON_MAX = 500;
