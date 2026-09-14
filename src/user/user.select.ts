/**
 * Single source of truth for the columns returned when reading a user profile.
 *
 * Shared by `UserService` (public / self views) and `AuthService` (`/me`) so the
 * selected field set never drifts between them — adding a profile column (e.g.
 * `region`) here propagates to every read path instead of being silently missed
 * in one of several hand-maintained select objects.
 */
export const USER_PROFILE_SELECT = {
  id: true,
  accountId: true,
  nickname: true,
  avatarUrl: true,
  avatarFrame: true,
  cover: true,
  email: true,
  phoneNumber: true,
  wechat: true,
  qq: true,
  whatsup: true,
  persona: true,
  helloWords: true,
  birthday: true,
  gender: true,
  city: true,
  region: true,
  role: true,
  status: true,
  lastOnline: true,
  receivedLikeCount: true,
  vipLevel: true,
  vipExpiresAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * `/me` view (also the PATCH /user/:id response) — the profile fields plus the
 * owner-only account fields. The fancy-number lease columns only feed
 * SelfUserDto's effective `fancyNumber`; the lease itself is never exposed.
 */
export const USER_ME_SELECT = {
  ...USER_PROFILE_SELECT,
  inviteCode: true,
  creditScore: true,
  fancyNumber: true,
  fancyNumberExpiresAt: true,
  fancyNumberPermanent: true,
} as const;
