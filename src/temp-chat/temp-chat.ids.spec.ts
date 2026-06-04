import { newGroupId, newGuestId } from './temp-chat.ids';

describe('temp-chat ids', () => {
  it('groupId 以 tmp 开头且不含连字符', () => {
    const id = newGroupId();
    expect(id.startsWith('tmp')).toBe(true);
    expect(id).not.toContain('-');
    expect(id.length).toBeGreaterThan(10);
  });

  it('guestId 以 g 开头且不含连字符', () => {
    const id = newGuestId();
    expect(id.startsWith('g')).toBe(true);
    expect(id).not.toContain('-');
  });

  it('连续生成不重复', () => {
    expect(newGroupId()).not.toBe(newGroupId());
  });
});
