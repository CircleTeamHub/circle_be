import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma';
import {
  CommerceQueryDto,
  MembershipQueryDto,
  OwnershipQueryDto,
} from './admin-commerce.dto';

@Injectable()
export class AdminCommerceService {
  constructor(private readonly prisma: PrismaService) {}
  async grants(userId: string, q: CommerceQueryDto) {
    const rows = await this.prisma.membershipGrant.findMany({
      where: { targetUserID: userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        operatorUserID: true,
        previousLevel: true,
        newLevel: true,
        newExpiresAt: true,
        note: true,
        createdAt: true,
      },
    });
    const items = rows.slice(0, q.limit);
    return {
      items,
      nextCursor: rows.length > q.limit ? items[items.length - 1].id : null,
    };
  }
  async ownership(q: OwnershipQueryDto) {
    const rows = await this.prisma.fancyNumber.findMany({
      where: {
        ...(q.search
          ? { value: { contains: q.search, mode: 'insensitive' } }
          : {}),
        ...(q.ids ? { id: { in: q.ids } } : {}),
      },
      orderBy: { id: 'asc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        value: true,
        status: true,
        leases: {
          where: { endedAt: null },
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: {
            user: { select: { id: true, accountId: true } },
            expiresAt: true,
            permanentAt: true,
          },
        },
      },
    });
    const items = rows.slice(0, q.limit);
    return {
      items,
      nextCursor: rows.length > q.limit ? items[items.length - 1].id : null,
    };
  }
  async memberships(q: MembershipQueryDto) {
    const now = new Date();
    const where: Prisma.UserWhereInput = {
      ...(q.search
        ? {
            OR: [
              { accountId: { contains: q.search, mode: 'insensitive' } },
              { nickname: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(q.level !== undefined ? { vipLevel: q.level } : {}),
      ...(q.expiry === 'expired'
        ? {
            vipLevel: {
              gt: 0,
              lt: 4,
              ...(q.level !== undefined ? { equals: q.level } : {}),
            },
            vipExpiresAt: { lte: now },
          }
        : {}),
      ...(q.expiry === 'lifetime'
        ? {
            AND: [
              { vipLevel: 4 },
              ...(q.level !== undefined ? [{ vipLevel: q.level }] : []),
            ],
          }
        : {}),
      ...(q.expiry === 'active'
        ? {
            AND: [
              { vipLevel: { gt: 0 } },
              {
                OR: [
                  { vipExpiresAt: { gt: now } },
                  { vipExpiresAt: null },
                  { vipLevel: 4 },
                ],
              },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: { id: 'asc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        accountId: true,
        nickname: true,
        vipLevel: true,
        vipExpiresAt: true,
        membershipGrantsReceived: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 10,
          select: {
            id: true,
            operatorUserID: true,
            previousLevel: true,
            newLevel: true,
            newExpiresAt: true,
            note: true,
            createdAt: true,
          },
        },
      },
    });
    const items = rows.slice(0, q.limit);
    return {
      items,
      nextCursor: rows.length > q.limit ? items[items.length - 1].id : null,
    };
  }
  async orders(q: CommerceQueryDto) {
    const rows = await this.prisma.fancyNumberOrder.findMany({
      where: q.search
        ? {
            OR: [
              {
                user: {
                  accountId: { contains: q.search, mode: 'insensitive' },
                },
              },
              {
                fancyNumber: {
                  value: { contains: q.search, mode: 'insensitive' },
                },
              },
            ],
          }
        : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        type: true,
        months: true,
        unitPrice: true,
        totalPrice: true,
        newExpiresAt: true,
        createdAt: true,
        user: { select: { id: true, accountId: true, nickname: true } },
        fancyNumber: {
          select: {
            value: true,
            status: true,
            leases: {
              where: { endedAt: null },
              take: 1,
              orderBy: { createdAt: 'desc' },
              select: {
                user: { select: { id: true, accountId: true } },
                expiresAt: true,
                permanentAt: true,
              },
            },
          },
        },
        lease: {
          select: {
            expiresAt: true,
            permanentAt: true,
            endedAt: true,
            endReason: true,
          },
        },
      },
    });
    const items = rows.slice(0, q.limit);
    return {
      items,
      nextCursor: rows.length > q.limit ? items[items.length - 1].id : null,
    };
  }
}
