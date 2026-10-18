import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma';
import { NoteService } from 'src/note/note.service';
import { AdminUserAuditService } from './admin-user-audit.service';
const person = {
  id: true,
  accountId: true,
  nickname: true,
  avatarUrl: true,
} as const;
const postSelect = {
  id: true,
  content: true,
  images: true,
  tags: true,
  city: true,
  cities: true,
  isHorn: true,
  noteID: true,
  status: true,
  viewCount: true,
  signupCount: true,
  _count: { select: { signups: true } },
  vipRestriction: true,
  creditRestriction: true,
  fancyRestriction: true,
  signupVipRestriction: true,
  signupCreditRestriction: true,
  signupFancyRestriction: true,
  createdAt: true,
  updatedAt: true,
  endedAt: true,
  expiresAt: true,
  author: { select: person },
  circle: { select: { id: true, name: true } },
  circleLinks: { select: { circle: { select: { id: true, name: true } } } },
} satisfies Prisma.CirclePostSelect;
type Page = { page: number; limit: number };
@Injectable()
export class AdminUserResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notes: NoteService,
    private readonly audit: AdminUserAuditService,
  ) {}
  private async user(id: string) {
    if (
      !(await this.prisma.user.findUnique({
        where: { id },
        select: { id: true },
      }))
    )
      throw new NotFoundException('用户不存在');
  }
  async circles(userID: string, q: Page) {
    await this.user(userID);
    const where = { userID, status: 'ACTIVE' as const };
    const [items, total] = await Promise.all([
      this.prisma.circleMember.findMany({
        where,
        select: {
          id: true,
          role: true,
          createdAt: true,
          circle: {
            select: {
              id: true,
              name: true,
              avatarUrl: true,
              memberCount: true,
              postCount: true,
              deleted: true,
              adminState: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.circleMember.count({ where }),
    ]);
    return { items, total, ...q };
  }
  async groups(userID: string, q: Page) {
    await this.user(userID);
    const where: Prisma.ChatMemberWhereInput = {
      userID,
      leftAt: null,
      conversation: { type: 'GROUP' },
    };
    const [rows, total] = await Promise.all([
      this.prisma.chatMember.findMany({
        where,
        select: {
          id: true,
          joinedAt: true,
          conversation: {
            select: {
              id: true,
              name: true,
              circleID: true,
              _count: { select: { members: { where: { leftAt: null } } } },
            },
          },
        },
        orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.chatMember.count({ where }),
    ]);
    const ids = rows.flatMap((r) =>
      r.conversation.circleID ? [r.conversation.circleID] : [],
    );
    const circles = ids.length
      ? await this.prisma.circle.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, deleted: true },
        })
      : [];
    const byId = new Map(circles.map((c) => [c.id, c]));
    return {
      items: rows.map(({ conversation, ...row }) => {
        const circle = conversation.circleID
          ? byId.get(conversation.circleID)
          : null;
        return {
          ...row,
          group: {
            id: conversation.id,
            name: circle?.name ?? conversation.name ?? '未命名群聊',
            memberCount: conversation._count.members,
            circle: circle ?? null,
          },
        };
      }),
      total,
      ...q,
    };
  }
  async posts(userID: string, q: Page) {
    await this.user(userID);
    const where = { authorID: userID };
    const [items, total] = await Promise.all([
      this.prisma.circlePost.findMany({
        where,
        select: {
          id: true,
          content: true,
          status: true,
          createdAt: true,
          circle: { select: { id: true, name: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.circlePost.count({ where }),
    ]);
    return { items, total, ...q };
  }
  async noteList(userID: string, q: Page) {
    await this.user(userID);
    const where: Prisma.NoteWhereInput = {
      ownerID: userID,
      status: { not: 'DELETED' },
    };
    const [rows, total] = await Promise.all([
      this.prisma.note.findMany({
        where,
        select: {
          id: true,
          title: true,
          status: true,
          available: true,
          workStatus: true,
          imageCount: true,
          videoCount: true,
          audioCount: true,
          collectedFromNoteID: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.note.count({ where }),
    ]);
    return {
      items: rows.map(({ collectedFromNoteID, ...note }) => ({
        ...note,
        isCollected: !!collectedFromNoteID,
      })),
      total,
      ...q,
    };
  }
  private record(
    actor: { userId: string; accountId?: string },
    userID: string,
    kind: 'NOTE' | 'POST',
    id: string,
  ) {
    return this.audit.recordInTransaction(this.prisma, {
      actorId: actor.userId,
      actorAccountId: actor.accountId ?? '',
      action: `ADMIN_USER_${kind}_VIEWED`,
      targetType: 'user',
      targetId: userID,
      metadata: { resourceId: id },
    });
  }
  async post(
    userID: string,
    id: string,
    actor: { userId: string; accountId?: string },
  ) {
    const post = await this.prisma.circlePost.findFirst({
      where: { id, authorID: userID },
      select: postSelect,
    });
    if (!post) throw new NotFoundException('该用户的动态不存在');
    await this.record(actor, userID, 'POST', id);
    const { _count, ...detail } = post;
    return { ...detail, signupCount: _count.signups };
  }
  async note(
    userID: string,
    id: string,
    actor: { userId: string; accountId?: string },
  ) {
    // Scope to the named owner before invoking the existing owner serializer and
    // media signer. Never pass the admin's identity as the note owner.
    const owned = await this.prisma.note.findFirst({
      where: { id, ownerID: userID, status: { not: 'DELETED' } },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('该用户的笔记不存在或已删除');
    const note = await this.notes.getNote(userID, id);
    await this.record(actor, userID, 'NOTE', id);
    return note;
  }
}
