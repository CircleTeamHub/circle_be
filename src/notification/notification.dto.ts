import { Prisma, NotificationType } from 'src/generated/prisma';

export type NotificationRealtimeDto = {
  id: string;
  type: NotificationType;
  content: string;
  read: boolean;
  createdAt: string;
  fromUser: { id: string; nickname: string; avatarUrl: string | null } | null;
  fromTrace: { id: string; excerpt: string; firstImage: string | null } | null;
  fromReply: { id: string; content: string } | null;
  fromCircle: { id: string; name: string } | null;
  fromCirclePost: {
    id: string;
    excerpt: string;
    firstImage: string | null;
  } | null;
  fromInvitation: { id: string; status: string } | null;
  squadRequest: {
    id: string;
    status: string;
    squad: { id: string; name: string } | null;
  } | null;
};

export const NOTIFICATION_REALTIME_INCLUDE = {
  fromUser: { select: { id: true, nickname: true, avatarUrl: true } },
  fromTrace: { select: { id: true, content: true, images: true } },
  fromReply: { select: { id: true, content: true } },
  fromCircle: { select: { id: true, name: true } },
  fromCirclePost: { select: { id: true, content: true, images: true } },
  fromInvitation: { select: { id: true, status: true } },
  squadRequest: {
    select: {
      id: true,
      status: true,
      toSquad: { select: { id: true, name: true } },
    },
  },
} as const;

export type NotificationRealtimeRow = Prisma.NotificationGetPayload<{
  include: typeof NOTIFICATION_REALTIME_INCLUDE;
}>;

export function mapNotificationRealtimeDto(
  n: NotificationRealtimeRow,
): NotificationRealtimeDto {
  return {
    id: n.id,
    type: n.type,
    content: n.content,
    read: n.read,
    createdAt: n.createdAt.toISOString(),
    fromUser: n.fromUser
      ? {
          id: n.fromUser.id,
          nickname: n.fromUser.nickname,
          avatarUrl: n.fromUser.avatarUrl,
        }
      : null,
    fromTrace: n.fromTrace
      ? {
          id: n.fromTrace.id,
          excerpt: n.fromTrace.content.slice(0, 60),
          firstImage: n.fromTrace.images[0] ?? null,
        }
      : null,
    fromReply: n.fromReply
      ? { id: n.fromReply.id, content: n.fromReply.content }
      : null,
    fromCircle: n.fromCircle
      ? { id: n.fromCircle.id, name: n.fromCircle.name }
      : null,
    fromCirclePost: n.fromCirclePost
      ? {
          id: n.fromCirclePost.id,
          excerpt: n.fromCirclePost.content.slice(0, 60),
          firstImage: n.fromCirclePost.images[0] ?? null,
        }
      : null,
    fromInvitation: n.fromInvitation
      ? { id: n.fromInvitation.id, status: n.fromInvitation.status }
      : null,
    squadRequest: n.squadRequest
      ? {
          id: n.squadRequest.id,
          status: n.squadRequest.status,
          squad: n.squadRequest.toSquad
            ? {
                id: n.squadRequest.toSquad.id,
                name: n.squadRequest.toSquad.name,
              }
            : null,
        }
      : null,
  };
}
