import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FriendState } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  FriendProfileDto,
  FriendRequestDto,
  FriendStatusDto,
} from './dto/friend.dto';

// Members (paid) get 5 000, regular users get 1 000.
const FRIEND_LIMIT_USER = 1_000;
const FRIEND_LIMIT_MEMBER = 5_000;

// Minimal user shape returned inside friend/request payloads
const MINI_USER_SELECT = {
  id: true,
  accountId: true,
  nickname: true,
  avatarUrl: true,
} as const;

// Full profile shape returned in the friend list
const FRIEND_PROFILE_SELECT = {
  id: true,
  accountId: true,
  nickname: true,
  avatarUrl: true,
  avatarFrame: true,
  gender: true,
  lastOnline: true,
} as const;

@Injectable()
export class FriendService {
  private readonly logger = new Logger(FriendService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Send request ────────────────────────────────────────────────────────────

  async sendRequest(
    senderId: string,
    targetId: string,
    message?: string,
  ): Promise<void> {
    if (senderId === targetId) {
      throw new BadRequestException('You cannot add yourself as a friend');
    }

    // Make sure the target user exists and is active
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, status: true, role: true },
    });
    if (!target || target.status !== 'ACTIVE') {
      throw new NotFoundException('User not found');
    }

    // Block check in both directions
    const block = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerID: senderId, blockedID: targetId },
          { blockerID: targetId, blockedID: senderId },
        ],
      },
    });
    if (block) {
      throw new ForbiddenException('Cannot send a friend request to this user');
    }

    // Already friends?
    const existing = await this.prisma.friend.findFirst({
      where: {
        OR: [
          { userID: senderId, friendID: targetId },
          { userID: targetId, friendID: senderId },
        ],
        state: { in: [FriendState.ACCEPTED, FriendState.PENDING] },
      },
    });
    if (existing) {
      throw new ConflictException(
        existing.state === FriendState.ACCEPTED
          ? 'Already friends'
          : 'Friend request already pending',
      );
    }

    // Enforce friend limit for the sender
    await this.assertBelowFriendLimit(senderId);

    // Upsert: if a REJECTED record exists (either direction), reset it to PENDING
    // so the user can retry after a rejection. Otherwise create fresh.
    const rejectedRecord = await this.prisma.friend.findFirst({
      where: {
        OR: [
          { userID: senderId, friendID: targetId },
          { userID: targetId, friendID: senderId },
        ],
        state: FriendState.REJECTED,
      },
    });

    if (rejectedRecord) {
      // Always store the new request as sender → target
      if (rejectedRecord.userID === senderId) {
        await this.prisma.friend.update({
          where: { id: rejectedRecord.id },
          data: { state: FriendState.PENDING, message: message ?? null },
        });
      } else {
        // Old record was target → sender; delete it and create fresh in correct direction
        await this.prisma.friend.delete({ where: { id: rejectedRecord.id } });
        await this.prisma.friend.create({
          data: {
            userID: senderId,
            friendID: targetId,
            state: FriendState.PENDING,
            message: message ?? null,
          },
        });
      }
    } else {
      await this.prisma.friend.create({
        data: {
          userID: senderId,
          friendID: targetId,
          state: FriendState.PENDING,
          message: message ?? null,
        },
      });
    }

    this.logger.log(`Friend request sent: ${senderId} → ${targetId}`);
  }

  // ─── Cancel request (sender withdraws) ───────────────────────────────────────

  async cancelRequest(senderId: string, requestId: string): Promise<void> {
    const record = await this.prisma.friend.findUnique({
      where: { id: requestId },
    });
    if (
      !record ||
      record.userID !== senderId ||
      record.state !== FriendState.PENDING
    ) {
      throw new NotFoundException('Pending request not found');
    }
    await this.prisma.friend.delete({ where: { id: requestId } });
  }

  // ─── Accept / Reject (recipient decides) ────────────────────────────────────

  async handleRequest(
    recipientId: string,
    requestId: string,
    decision: 'ACCEPTED' | 'REJECTED',
  ): Promise<void> {
    const record = await this.prisma.friend.findUnique({
      where: { id: requestId },
    });
    if (
      !record ||
      record.friendID !== recipientId ||
      record.state !== FriendState.PENDING
    ) {
      throw new NotFoundException('Pending request not found');
    }

    if (decision === FriendState.ACCEPTED) {
      // Enforce friend limit for the recipient too
      await this.assertBelowFriendLimit(recipientId);
    }

    await this.prisma.friend.update({
      where: { id: requestId },
      data: { state: decision },
    });
  }

  // ─── Remove friend ────────────────────────────────────────────────────────────

  async removeFriend(userId: string, friendId: string): Promise<void> {
    const record = await this.prisma.friend.findFirst({
      where: {
        OR: [
          { userID: userId, friendID: friendId },
          { userID: friendId, friendID: userId },
        ],
        state: FriendState.ACCEPTED,
      },
    });
    if (!record) {
      throw new NotFoundException('Friendship not found');
    }
    await this.prisma.friend.delete({ where: { id: record.id } });
  }

  // ─── Lists ────────────────────────────────────────────────────────────────────

  async listFriends(userId: string): Promise<FriendProfileDto[]> {
    const records = await this.prisma.friend.findMany({
      where: {
        OR: [{ userID: userId }, { friendID: userId }],
        state: FriendState.ACCEPTED,
      },
      orderBy: { updatedAt: 'desc' },
    });

    const friendIds = records.map((r) =>
      r.userID === userId ? r.friendID : r.userID,
    );
    const users = await this.prisma.user.findMany({
      where: { id: { in: friendIds }, status: 'ACTIVE' },
      select: FRIEND_PROFILE_SELECT,
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return records
      .map((r) => {
        const fid = r.userID === userId ? r.friendID : r.userID;
        const u = userMap.get(fid);
        if (!u) return null;
        return { ...u, friendsSince: r.updatedAt } as FriendProfileDto;
      })
      .filter((x): x is FriendProfileDto => x !== null);
  }

  async listIncomingRequests(userId: string): Promise<FriendRequestDto[]> {
    const records = await this.prisma.friend.findMany({
      where: { friendID: userId, state: FriendState.PENDING },
      orderBy: { createdAt: 'desc' },
    });

    const senderIds = records.map((r) => r.userID);
    const users = await this.prisma.user.findMany({
      where: { id: { in: senderIds }, status: 'ACTIVE' },
      select: MINI_USER_SELECT,
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return records
      .filter((r) => userMap.has(r.userID))
      .map((r) => ({
        id: r.id,
        state: r.state,
        createdAt: r.createdAt,
        message: r.message,
        user: userMap.get(r.userID)!,
      }));
  }

  async listOutgoingRequests(userId: string): Promise<FriendRequestDto[]> {
    const records = await this.prisma.friend.findMany({
      where: { userID: userId, state: FriendState.PENDING },
      orderBy: { createdAt: 'desc' },
    });

    const targetIds = records.map((r) => r.friendID);
    const users = await this.prisma.user.findMany({
      where: { id: { in: targetIds }, status: 'ACTIVE' },
      select: MINI_USER_SELECT,
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return records
      .filter((r) => userMap.has(r.friendID))
      .map((r) => ({
        id: r.id,
        state: r.state,
        createdAt: r.createdAt,
        message: r.message,
        user: userMap.get(r.friendID)!,
      }));
  }

  // ─── Relationship status ─────────────────────────────────────────────────────

  async getStatus(
    viewerId: string,
    targetId: string,
  ): Promise<FriendStatusDto> {
    // Block wins over everything
    const block = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerID: viewerId, blockedID: targetId },
          { blockerID: targetId, blockedID: viewerId },
        ],
      },
    });
    if (block) {
      return { status: 'BLOCKED', requestId: null };
    }

    const record = await this.prisma.friend.findFirst({
      where: {
        OR: [
          { userID: viewerId, friendID: targetId },
          { userID: targetId, friendID: viewerId },
        ],
        state: { in: [FriendState.PENDING, FriendState.ACCEPTED] },
      },
    });

    if (!record) return { status: 'NONE', requestId: null };
    if (record.state === FriendState.ACCEPTED)
      return { status: 'ACCEPTED', requestId: record.id };
    if (record.userID === viewerId)
      return { status: 'PENDING_SENT', requestId: record.id };
    return { status: 'PENDING_RECEIVED', requestId: record.id };
  }

  // ─── Block / Unblock ─────────────────────────────────────────────────────────

  async blockUser(blockerId: string, targetId: string): Promise<void> {
    if (blockerId === targetId) {
      throw new BadRequestException('Cannot block yourself');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, status: true },
    });
    if (!target || target.status !== 'ACTIVE') {
      throw new NotFoundException('User not found');
    }

    const already = await this.prisma.block.findUnique({
      where: {
        blockerID_blockedID: { blockerID: blockerId, blockedID: targetId },
      },
    });
    if (already) throw new ConflictException('User already blocked');

    // Remove friendship if exists (any state) in a transaction
    await this.prisma.$transaction([
      this.prisma.friend.deleteMany({
        where: {
          OR: [
            { userID: blockerId, friendID: targetId },
            { userID: targetId, friendID: blockerId },
          ],
        },
      }),
      this.prisma.block.create({
        data: { blockerID: blockerId, blockedID: targetId },
      }),
    ]);

    this.logger.log(`Block created: ${blockerId} → ${targetId}`);
  }

  async unblockUser(blockerId: string, targetId: string): Promise<void> {
    const record = await this.prisma.block.findUnique({
      where: {
        blockerID_blockedID: { blockerID: blockerId, blockedID: targetId },
      },
    });
    if (!record) throw new NotFoundException('Block not found');
    await this.prisma.block.delete({
      where: {
        blockerID_blockedID: { blockerID: blockerId, blockedID: targetId },
      },
    });
  }

  async listBlocked(userId: string) {
    const blocks = await this.prisma.block.findMany({
      where: { blockerID: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        blocked: { select: MINI_USER_SELECT },
      },
    });
    return blocks.map((b) => ({ ...b.blocked, blockedAt: b.createdAt }));
  }

  // ─── Remark ───────────────────────────────────────────────────────────────────

  /**
   * Set (or clear) the private remark a user has for one of their friends.
   * Remark is stored on the shared Friend record:
   *   remarkA = userID's label for friendID
   *   remarkB = friendID's label for userID
   */
  async setRemark(
    userId: string,
    friendUserId: string,
    remark: string | null,
  ): Promise<void> {
    const record = await this.prisma.friend.findFirst({
      where: {
        OR: [
          { userID: userId, friendID: friendUserId },
          { userID: friendUserId, friendID: userId },
        ],
        state: FriendState.ACCEPTED,
      },
    });
    if (!record) throw new NotFoundException('Friendship not found');

    const field = record.userID === userId ? 'remarkA' : 'remarkB';
    await this.prisma.friend.update({
      where: { id: record.id },
      data: { [field]: remark },
    });
  }

  // ─── Friend tags ──────────────────────────────────────────────────────────────

  async listMyTags(userId: string) {
    return this.prisma.friendTag.findMany({
      where: { ownerID: userId },
      orderBy: { name: 'asc' },
    });
  }

  async createTag(userId: string, name: string, color?: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('Tag name cannot be empty');
    return this.prisma.friendTag.upsert({
      where: { ownerID_name: { ownerID: userId, name: trimmed } },
      update: { color: color ?? undefined },
      create: { ownerID: userId, name: trimmed, color: color ?? null },
    });
  }

  async deleteTag(userId: string, tagId: string): Promise<void> {
    const tag = await this.prisma.friendTag.findUnique({
      where: { id: tagId },
    });
    if (!tag || tag.ownerID !== userId)
      throw new NotFoundException('Tag not found');
    await this.prisma.friendTag.delete({ where: { id: tagId } });
  }

  /** Assign a tag to a friendship (idempotent). */
  async assignTag(
    userId: string,
    friendUserId: string,
    tagId: string,
  ): Promise<void> {
    const [friendship, tag] = await Promise.all([
      this.prisma.friend.findFirst({
        where: {
          OR: [
            { userID: userId, friendID: friendUserId },
            { userID: friendUserId, friendID: userId },
          ],
          state: FriendState.ACCEPTED,
        },
      }),
      this.prisma.friendTag.findUnique({ where: { id: tagId } }),
    ]);

    if (!friendship) throw new NotFoundException('Friendship not found');
    if (!tag || tag.ownerID !== userId)
      throw new NotFoundException('Tag not found');

    await this.prisma.friendTagOnFriend.upsert({
      where: {
        ownerID_tagID_friendID: {
          ownerID: userId,
          tagID: tagId,
          friendID: friendship.id,
        },
      },
      update: {},
      create: { ownerID: userId, tagID: tagId, friendID: friendship.id },
    });
  }

  /** Remove a tag from a friendship. */
  async removeTag(
    userId: string,
    friendUserId: string,
    tagId: string,
  ): Promise<void> {
    const friendship = await this.prisma.friend.findFirst({
      where: {
        OR: [
          { userID: userId, friendID: friendUserId },
          { userID: friendUserId, friendID: userId },
        ],
        state: FriendState.ACCEPTED,
      },
    });
    if (!friendship) throw new NotFoundException('Friendship not found');

    await this.prisma.friendTagOnFriend.deleteMany({
      where: { ownerID: userId, tagID: tagId, friendID: friendship.id },
    });
  }

  /** List all friends that have a given tag. */
  async listFriendsByTag(
    userId: string,
    tagId: string,
  ): Promise<FriendProfileDto[]> {
    const tag = await this.prisma.friendTag.findUnique({
      where: { id: tagId },
    });
    if (!tag || tag.ownerID !== userId)
      throw new NotFoundException('Tag not found');

    const links = await this.prisma.friendTagOnFriend.findMany({
      where: { ownerID: userId, tagID: tagId },
      include: { friendship: true },
    });

    const friendUserIds = links.map((l) => {
      const f = l.friendship;
      return f.userID === userId ? f.friendID : f.userID;
    });

    const users = await this.prisma.user.findMany({
      where: { id: { in: friendUserIds }, status: 'ACTIVE' },
      select: FRIEND_PROFILE_SELECT,
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return links
      .map((l) => {
        const f = l.friendship;
        const fid = f.userID === userId ? f.friendID : f.userID;
        const u = userMap.get(fid);
        if (!u) return null;
        return { ...u, friendsSince: f.updatedAt } as FriendProfileDto;
      })
      .filter((x): x is FriendProfileDto => x !== null);
  }

  // ─── Helper ───────────────────────────────────────────────────────────────────

  private async assertBelowFriendLimit(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    const limit =
      user?.role === 'MEMBER' || user?.role === 'ADMIN'
        ? FRIEND_LIMIT_MEMBER
        : FRIEND_LIMIT_USER;

    const count = await this.prisma.friend.count({
      where: {
        OR: [{ userID: userId }, { friendID: userId }],
        state: FriendState.ACCEPTED,
      },
    });

    if (count >= limit) {
      throw new ForbiddenException(
        `Friend limit reached (${limit}). Upgrade to MEMBER for a higher limit.`,
      );
    }
  }
}
