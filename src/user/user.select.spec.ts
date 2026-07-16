import { USER_ME_SELECT, USER_PROFILE_SELECT } from './user.select';

describe('user invite-code selection', () => {
  it('exposes inviteCode only to the authenticated account owner', () => {
    expect('inviteCode' in USER_ME_SELECT).toBe(true);
    expect('inviteCode' in USER_PROFILE_SELECT).toBe(false);
  });
});
