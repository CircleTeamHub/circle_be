import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminPageQuery } from 'src/admin-access/admin-access.dto';
import { generateInviteCode } from 'src/utils/account-id';
import {
  CreateCampaignDto,
  ReferralQuery,
  UpdateCampaignDto,
} from './admin-operations.dto';
import {
  runAdminOperation,
  writeOperationAudit,
} from './admin-operation-request';
import {
  buildCampaignSearchCountQuery,
  buildCampaignSearchPageQuery,
  buildReferralSearchCountQuery,
  buildReferralSearchPageQuery,
} from './admin-invite-search.query';

const USER_SUMMARY = {
  id: true,
  accountId: true,
  nickname: true,
  status: true,
} as const;

const REFERRAL_LIST_SELECT = {
  id: true,
  status: true,
  inviterReward: true,
  inviteeReward: true,
  createdAt: true,
  rewardedAt: true,
  eligibleAt: true,
  failureReason: true,
  inviter: { select: USER_SUMMARY },
  invitee: { select: USER_SUMMARY },
} as const;

/** 按 UNION 查询给出的页内顺序排列回查结果;两次查询之间消失的行跳过。 */
function inPageOrder<T extends { id: string }>(ids: string[], rows: T[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

@Injectable()
export class AdminInviteService {
  constructor(private readonly prisma: PrismaService) {}

  async personalCodes(query: AdminPageQuery) {
    const where = {
      status: 'ACTIVE' as const,
      role: { not: 'ADMIN' as const },
      ...(query.search
        ? {
            OR: [
              {
                accountId: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                nickname: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
              {
                inviteCode: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          ...USER_SUMMARY,
          inviteCode: true,
          _count: { select: { referralsSent: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  async campaigns(query: AdminPageQuery) {
    // 关键词搜索:原 OR 里的发起人关系条件编译成跨 LEFT JOIN 的 OR,用不上 trigram
    // 索引;改成 UNION 查询取页内 id 和 total(口径一致,见 admin-invite-search.query.ts)。
    if (query.search) {
      const [page, counted] = await this.prisma.$transaction([
        this.prisma.$queryRaw<Array<{ id: string }>>(
          buildCampaignSearchPageQuery({
            search: query.search,
            limit: query.limit,
            offset: (query.page - 1) * query.limit,
          }),
        ),
        this.prisma.$queryRaw<Array<{ total: number }>>(
          buildCampaignSearchCountQuery({ search: query.search }),
        ),
      ]);
      const ids = page.map((row) => row.id);
      const rows = ids.length
        ? await this.prisma.campaignInvite.findMany({
            where: { id: { in: ids } },
            include: { owner: { select: USER_SUMMARY } },
          })
        : [];
      return {
        items: inPageOrder(ids, rows),
        total: counted[0]?.total ?? 0,
        page: query.page,
        limit: query.limit,
      };
    }
    const where = {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.campaignInvite.findMany({
        where,
        include: { owner: { select: USER_SUMMARY } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.campaignInvite.count({ where }),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  async referrals(query: ReferralQuery) {
    // 关键词搜索:原 OR 里的邀请人/被邀请人关系条件编译成跨 LEFT JOIN 的 OR,用不上
    // trigram 索引;改成 UNION 查询取页内 id 和 total(口径一致,见
    // admin-invite-search.query.ts),status / campaignID 照旧是 AND 条件。
    if (query.search) {
      const filter = {
        search: query.search,
        status: query.status,
        campaignID: query.campaignID,
      };
      const [page, counted] = await this.prisma.$transaction([
        this.prisma.$queryRaw<Array<{ id: string }>>(
          buildReferralSearchPageQuery({
            ...filter,
            limit: query.limit,
            offset: (query.page - 1) * query.limit,
          }),
        ),
        this.prisma.$queryRaw<Array<{ total: number }>>(
          buildReferralSearchCountQuery(filter),
        ),
      ]);
      const ids = page.map((row) => row.id);
      const rows = ids.length
        ? await this.prisma.referral.findMany({
            where: { id: { in: ids } },
            select: REFERRAL_LIST_SELECT,
          })
        : [];
      return {
        items: inPageOrder(ids, rows),
        total: counted[0]?.total ?? 0,
        page: query.page,
        limit: query.limit,
      };
    }
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.campaignID
        ? { invitee: { campaignInviteUse: { campaignID: query.campaignID } } }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.referral.findMany({
        where,
        select: REFERRAL_LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.referral.count({ where }),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  create(actorID: string, dto: CreateCampaignDto, key?: string) {
    this.checkExpiry(dto.expiresAt);
    return runAdminOperation(
      this.prisma,
      actorID,
      'campaign.create',
      key,
      dto,
      async (tx) => {
        const owner = await tx.user.findUnique({
          where: { accountId: dto.ownerAccountId.trim().toLowerCase() },
          select: USER_SUMMARY,
        });
        if (!owner || owner.status !== 'ACTIVE')
          throw new NotFoundException('未找到可用邀请人账号');
        const ownerRole = await tx.user.findUnique({
          where: { id: owner.id },
          select: { role: true },
        });
        if (ownerRole?.role === 'ADMIN')
          throw new BadRequestException('邀请人需要使用普通 App 账号');
        const items: Array<{ id: string; code: string }> = [];
        for (let index = 0; index < dto.count; index += 1) {
          let created = false;
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const code = generateInviteCode();
            const identifierValue = code.toLowerCase();
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identifierValue}, 0))`;
            if (
              await tx.accountIdentifier.findUnique({
                where: { value: identifierValue },
                select: { value: true },
              })
            )
              continue;
            await tx.accountIdentifier.create({
              data: { value: identifierValue },
            });
            const row = await tx.campaignInvite.create({
              data: {
                code,
                identifierValue,
                name: dto.name,
                ownerUserID: owner.id,
                maxUses: dto.maxUses,
                expiresAt: new Date(dto.expiresAt),
              },
            });
            items.push({ id: row.id, code });
            created = true;
            break;
          }
          if (!created)
            throw new ServiceUnavailableException(
              '暂时无法生成邀请码，请稍后重试',
            );
        }
        await writeOperationAudit(
          tx,
          actorID,
          'campaign_invite.create',
          'campaign_invite',
          undefined,
          dto.reason,
          undefined,
          { count: items.length, ownerUserID: owner.id },
        );
        return { items };
      },
    );
  }

  update(actorID: string, id: string, dto: UpdateCampaignDto) {
    this.checkExpiry(dto.expiresAt, !dto.enabled);
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.campaignInvite.findUnique({ where: { id } });
      if (!previous) throw new NotFoundException('邀请码不存在');
      if (dto.maxUses < previous.usedCount)
        throw new BadRequestException('使用上限不能小于已使用人数');
      const changed = await tx.campaignInvite.updateMany({
        where: { id, version: dto.version, usedCount: { lte: dto.maxUses } },
        data: {
          enabled: dto.enabled,
          maxUses: dto.maxUses,
          expiresAt: new Date(dto.expiresAt),
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw new ConflictException('邀请码配置或使用人数已变化，请刷新后重试');
      await writeOperationAudit(
        tx,
        actorID,
        'campaign_invite.update',
        'campaign_invite',
        id,
        dto.reason,
        {
          enabled: previous.enabled,
          maxUses: previous.maxUses,
          expiresAt: previous.expiresAt.toISOString(),
        },
        {
          enabled: dto.enabled,
          maxUses: dto.maxUses,
          expiresAt: dto.expiresAt,
        },
      );
      return tx.campaignInvite.findUnique({ where: { id } });
    });
  }

  private checkExpiry(value: string, allowExpired = false) {
    if (!allowExpired && new Date(value) <= new Date())
      throw new BadRequestException('邀请码有效期必须晚于当前时间');
  }
}
