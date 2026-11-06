import { assertGroupJoinAllowed } from './group-join-ban';

describe('group join blacklist', () => {
  const tx = { chatGroupJoinBan: { findFirst: jest.fn() } };

  it('allows an applicant absent from the group blacklist', async () => {
    tx.chatGroupJoinBan.findFirst.mockResolvedValue(null);
    await expect(
      assertGroupJoinAllowed(tx as never, {
        conversationID: 'group',
        userID: 'applicant',
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    { conversationID: 'group', userID: 'applicant' },
    { conversation: { circleID: 'circle' }, userID: { in: ['applicant'] } },
  ])(
    'blocks group and circle admission using the same persisted ban',
    async (where) => {
      tx.chatGroupJoinBan.findFirst.mockResolvedValue({ userID: 'applicant' });
      await expect(
        assertGroupJoinAllowed(tx as never, where),
      ).rejects.toMatchObject({
        response: { errorCode: 'CHAT_GROUP_JOIN_BLOCKED' },
      });
      expect(tx.chatGroupJoinBan.findFirst).toHaveBeenLastCalledWith({
        where,
        select: { userID: true },
      });
    },
  );
});
