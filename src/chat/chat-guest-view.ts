import type { ChatMessageDto } from './chat.types';

/**
 * Room-local stand-in for an account id in everything a temp-chat guest
 * receives. A TEMP conversation seats exactly one account member — the host —
 * so every non-guest id a guest could see is the host's.
 */
export const TEMP_CHAT_HOST_ALIAS = 'host';

/** Guest ids are `g` + 32 hex chars (temp-chat.ids.ts newGuestId); account ids are UUIDs. */
const GUEST_USER_ID = /^g[0-9a-f]{32}$/;

export function isGuestUserId(id: string): boolean {
  return GUEST_USER_ID.test(id);
}

function aliasAccountId(id: string): string {
  return isGuestUserId(id) ? id : TEMP_CHAT_HOST_ALIAS;
}

/**
 * The guest's view of a message: account ids (the host's) on the sender,
 * `revokedBy` and reaction lists become TEMP_CHAT_HOST_ALIAS, so an anonymous
 * link holder never learns the host's account UUID — which would let them open
 * a direct chat, send a friend request or fetch the profile once registered.
 * The guest page only needs "this came from the host", which the alias and the
 * member list's `isHost` flag already say.
 *
 * `content` is left as sent: a shared card is the sender's deliberate payload.
 * Never mutates the input — the same DTO is still delivered to the host.
 */
export function toGuestMessageView(message: ChatMessageDto): ChatMessageDto {
  const view: ChatMessageDto = { ...message };
  if (message.sender && !isGuestUserId(message.sender.id)) {
    view.sender = { ...message.sender, id: TEMP_CHAT_HOST_ALIAS };
  }
  if (typeof message.revokedBy === 'string') {
    view.revokedBy = aliasAccountId(message.revokedBy);
  }
  if (message.reactions) {
    view.reactions = message.reactions.map((reaction) => ({
      ...reaction,
      userIds: reaction.userIds.map(aliasAccountId),
    }));
  }
  return view;
}
