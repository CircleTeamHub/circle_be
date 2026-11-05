import { ChatService } from './chat.service';
import type { ChatConversation } from 'src/generated/prisma';

describe('group notice conversation serialization', () => {
  const read = (
    changes: Partial<ChatConversation>,
    circle: { description: string; memberCanInvite: boolean } | null = null,
  ) =>
    ChatService.prototype['groupFacets'](
      {
        type: 'GROUP',
        circleID: null,
        notice: '独立群公告',
        noticePinned: true,
        muteAllAt: null,
        ...changes,
      } as ChatConversation,
      { role: 'MEMBER', leftAt: null } as never,
      circle,
      'MEMBER',
      2,
    );

  it('includes standalone announcement text and the shared broadcast flag', () => {
    expect(read({})).toMatchObject({
      notice: '独立群公告',
      noticePinned: true,
    });
  });
  it('maps circle description into the same notice field', () => {
    expect(
      read(
        { circleID: 'circle-1' },
        { description: '圈子群公告', memberCanInvite: true },
      ),
    ).toMatchObject({ notice: '圈子群公告', noticePinned: true });
  });
  it('defaults a legacy missing broadcast flag to false', () => {
    expect(read({ noticePinned: undefined }).noticePinned).toBe(false);
  });
  it('never exposes a group broadcast on a direct conversation', () => {
    expect(read({ type: 'DIRECT' })).toMatchObject({
      notice: null,
      noticePinned: false,
    });
  });
});
