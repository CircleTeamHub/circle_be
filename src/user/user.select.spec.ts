import { USER_ME_SELECT, USER_PROFILE_SELECT } from './user.select';

describe('user invite-code selection', () => {
  it('exposes inviteCode only to the authenticated account owner', () => {
    expect('inviteCode' in USER_ME_SELECT).toBe(true);
    expect('inviteCode' in USER_PROFILE_SELECT).toBe(false);
  });
});

// 靓号标记只在自视图（/auth/me、PATCH /user/:id）上需要：客户端 UserProfileScreen
// 在 feature flag 后面读 currentUser.fancyNumber，而这一列此前根本没被选出来，
// 到达前端的永远是 undefined。靓号是有租期的，到期由 fancy-number 流程惰性回收，
// 所以租期两列也要一起选出来，SelfUserDto 才能按 resolveEffectiveFancyNumber 判有效。
describe('user self-view selection', () => {
  it.each(['fancyNumber', 'fancyNumberExpiresAt', 'fancyNumberPermanent'])(
    'selects %s for the owner view only',
    (column) => {
      expect(column in USER_ME_SELECT).toBe(true);
      expect(column in USER_PROFILE_SELECT).toBe(false);
    },
  );
});
