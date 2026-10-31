import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  ASSISTANT_INFO_SOURCE_PLAZA_POST,
  ASSISTANT_KEY,
} from './assistant.constants';
import {
  CreateAssistantSubscriptionDto,
  UpdateAssistantSubscriptionDto,
} from './assistant.dto';

const MAX_INFO_DELIVERIES_PER_POST = 5_000;

export type AssistantCircleContext = {
  id: string;
  name: string;
  cities: string[];
};

export type AssistantSubscriptionDto = {
  id: string;
  circleId: string;
  circleName: string;
  circleCities: string[];
  cities: string[];
  keywords: string[];
  followsCircleCities: boolean;
  sourceTypes: string[];
  enabled: boolean;
  pushEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type AccessibleCircle = {
  id: string;
  name: string;
  cities: string[];
};

type SubscriptionWithCircle = {
  id: string;
  circleID: string;
  cities: string[];
  keywords: string[];
  sourceTypes: string[];
  enabled: boolean;
  pushEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  circle: AccessibleCircle;
};

type InfoAlertPayload = {
  kind: 'info-alert';
  alertKey: string;
  subscriptionIds: string[];
  circleId: string;
  circleName: string;
  sourceType: 'PLAZA_POST';
  sourceId: string;
  title: string;
  summary: string;
  matchedCities: string[];
  pushEnabled?: boolean;
  publishedAt: string;
  target: {
    route: 'plaza-post-detail';
    id: string;
  };
  text: string;
};

@Injectable()
export class AssistantSubscriptionService {
  private readonly logger = new Logger(AssistantSubscriptionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<AssistantSubscriptionDto[]> {
    const rows = await this.prisma.assistantSubscription.findMany({
      where: { userID: userId },
      include: {
        circle: { select: { id: true, name: true, cities: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toDto(row as SubscriptionWithCircle));
  }

  async getContextCircle(
    userId: string,
    circleId: string | undefined,
  ): Promise<AssistantCircleContext | null> {
    if (!circleId) return null;
    const circle = await this.findAccessibleCircle(userId, circleId);
    return circle;
  }

  async create(
    userId: string,
    dto: CreateAssistantSubscriptionDto,
  ): Promise<AssistantSubscriptionDto> {
    const circle = await this.requireAccessibleCircle(userId, dto.circleId);
    const cities = this.validateSelectedCities(dto.cities, circle.cities);
    const keywords = this.normalizeKeywords(dto.keywords);
    const row = await this.prisma.assistantSubscription.upsert({
      where: {
        userID_assistantKey_circleID: {
          userID: userId,
          assistantKey: ASSISTANT_KEY,
          circleID: circle.id,
        },
      },
      create: {
        userID: userId,
        assistantKey: ASSISTANT_KEY,
        circleID: circle.id,
        cities,
        keywords,
        sourceTypes: [ASSISTANT_INFO_SOURCE_PLAZA_POST],
        pushEnabled: dto.pushEnabled ?? true,
      },
      update: {
        cities,
        keywords,
        sourceTypes: [ASSISTANT_INFO_SOURCE_PLAZA_POST],
        enabled: true,
        ...(dto.pushEnabled === undefined
          ? {}
          : { pushEnabled: dto.pushEnabled }),
      },
      include: {
        circle: { select: { id: true, name: true, cities: true } },
      },
    });
    return this.toDto(row as SubscriptionWithCircle);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateAssistantSubscriptionDto,
  ): Promise<AssistantSubscriptionDto> {
    const existing = await this.prisma.assistantSubscription.findFirst({
      where: { id, userID: userId },
      include: {
        circle: { select: { id: true, name: true, cities: true } },
      },
    });
    if (!existing) {
      throw new NotFoundException('助手订阅不存在');
    }
    const cities =
      dto.cities === undefined
        ? existing.cities
        : this.validateSelectedCities(dto.cities, existing.circle.cities);
    const keywords =
      dto.keywords === undefined
        ? existing.keywords
        : this.normalizeKeywords(dto.keywords);
    const row = await this.prisma.assistantSubscription.update({
      where: { id },
      data: {
        cities,
        keywords,
        ...(dto.enabled === undefined ? {} : { enabled: dto.enabled }),
        ...(dto.pushEnabled === undefined
          ? {}
          : { pushEnabled: dto.pushEnabled }),
      },
      include: {
        circle: { select: { id: true, name: true, cities: true } },
      },
    });
    return this.toDto(row as SubscriptionWithCircle);
  }

  async remove(userId: string, id: string): Promise<void> {
    const deleted = await this.prisma.assistantSubscription.deleteMany({
      where: { id, userID: userId },
    });
    if (deleted.count === 0) {
      throw new NotFoundException('助手订阅不存在');
    }
  }

  /**
   * 在圈子帖子事务内创建提醒投递记录。投递记录只保存短摘要和内部目标 id，
   * 不保存帖子正文或媒体 URL；发送由 AssistantAlertDeliveryProcessor 负责。
   */
  async enqueueCirclePost(
    tx: Prisma.TransactionClient,
    postId: string,
    authorId: string,
    circleIds: string[],
  ): Promise<number> {
    const linkedCircleIds = [...new Set(circleIds.filter(Boolean))];
    if (linkedCircleIds.length === 0) return 0;
    const post = await tx.circlePost.findUnique({
      where: { id: postId },
      select: {
        id: true,
        content: true,
        tags: true,
        city: true,
        cities: true,
        authorID: true,
        createdAt: true,
        circleLinks: { select: { circleID: true } },
      },
    });
    if (!post || post.authorID !== authorId) return 0;

    const subscriptions = await tx.assistantSubscription.findMany({
      where: {
        userID: { not: authorId },
        circleID: { in: linkedCircleIds },
        enabled: true,
        sourceTypes: { has: ASSISTANT_INFO_SOURCE_PLAZA_POST },
      },
      select: {
        id: true,
        userID: true,
        circleID: true,
        cities: true,
        keywords: true,
        sourceTypes: true,
        pushEnabled: true,
        circle: {
          select: { id: true, name: true, cities: true, ownerID: true },
        },
      },
      orderBy: { id: 'asc' },
      take: MAX_INFO_DELIVERIES_PER_POST + 1,
    });
    if (subscriptions.length === 0) return 0;
    if (subscriptions.length > MAX_INFO_DELIVERIES_PER_POST) {
      this.logger.warn(
        `assistant info candidates capped at ${MAX_INFO_DELIVERIES_PER_POST} before matching (post=${postId})`,
      );
    }

    // 成员身份只在订阅创建时校验过；退圈或被移出后订阅行还在，按当前身份再筛一次，
    // 否则前成员会继续通过小助手收到圈内帖子。群主不一定有成员行，单独放行。
    const memberships = await tx.circleMember.findMany({
      where: {
        circleID: { in: linkedCircleIds },
        userID: { in: [...new Set(subscriptions.map((sub) => sub.userID))] },
        status: 'ACTIVE',
      },
      select: { circleID: true, userID: true },
    });
    const activeMembers = new Set(
      memberships.map((member) => `${member.circleID}:${member.userID}`),
    );

    const postCircleIds = new Set(
      post.circleLinks.map((link) => link.circleID),
    );
    let rawPostCities: string[];
    if (post.cities.length > 0) {
      rawPostCities = post.cities;
    } else if (post.city) {
      rawPostCities = [post.city];
    } else {
      rawPostCities = [];
    }
    const postCities = this.normalizeList(rawPostCities);
    const grouped = new Map<
      string,
      {
        userId: string;
        subscriptionIds: string[];
        circleId: string;
        circleName: string;
        matchedCities: Set<string>;
        pushEnabled: boolean;
      }
    >();

    for (const subscription of subscriptions) {
      if (!postCircleIds.has(subscription.circleID)) continue;
      if (
        subscription.circle.ownerID !== subscription.userID &&
        !activeMembers.has(`${subscription.circleID}:${subscription.userID}`)
      ) {
        continue;
      }
      if (!this.matchesKeywords(post, subscription.keywords)) continue;
      const scopeCities = this.normalizeList(
        subscription.cities.length > 0
          ? subscription.cities
          : subscription.circle.cities,
      );
      let matchedCities: string[];
      if (scopeCities.length === 0) {
        matchedCities = postCities;
      } else {
        matchedCities = postCities.filter((city) => scopeCities.includes(city));
      }
      if (scopeCities.length > 0 && matchedCities.length === 0) continue;

      const current = grouped.get(subscription.userID) ?? {
        userId: subscription.userID,
        subscriptionIds: [],
        circleId: subscription.circleID,
        circleName: subscription.circle.name,
        matchedCities: new Set<string>(),
        pushEnabled: false,
      };
      current.subscriptionIds.push(subscription.id);
      current.pushEnabled ||= subscription.pushEnabled;
      for (const city of matchedCities) current.matchedCities.add(city);
      grouped.set(subscription.userID, current);
    }

    const rows = [...grouped.values()];
    if (rows.length === 0) return 0;
    const sourceVersion = '1';
    const title = this.firstLine(post.content) || '圈子有新的城市信息';
    const summary = this.clamp(post.content.trim(), 240);
    const data = rows.slice(0, MAX_INFO_DELIVERIES_PER_POST).map((row) => {
      const alertKey = [
        ASSISTANT_KEY,
        'info',
        row.userId,
        post.id,
        sourceVersion,
      ].join(':');
      const payload: InfoAlertPayload = {
        kind: 'info-alert',
        alertKey,
        subscriptionIds: row.subscriptionIds,
        circleId: row.circleId,
        circleName: row.circleName,
        sourceType: 'PLAZA_POST',
        sourceId: post.id,
        title,
        summary,
        matchedCities: [...row.matchedCities],
        pushEnabled: row.pushEnabled,
        publishedAt: post.createdAt.toISOString(),
        target: { route: 'plaza-post-detail', id: post.id },
        text: '风信助手有一条新的城市信息提醒。',
      };
      return {
        userID: row.userId,
        assistantKey: ASSISTANT_KEY,
        subscriptionIDs: row.subscriptionIds,
        eventType: 'INFO_PUBLISHED' as const,
        sourceID: post.id,
        sourceVersion,
        dedupeKey: alertKey,
        payloadSnapshot: payload as unknown as Prisma.InputJsonObject,
      };
    });
    if (data.length === 0) return 0;
    const result = await tx.assistantAlertDelivery.createMany({
      data,
      skipDuplicates: true,
    });
    return result.count;
  }

  private async findAccessibleCircle(
    userId: string,
    circleId: string,
  ): Promise<AccessibleCircle | null> {
    return this.prisma.circle.findFirst({
      where: {
        id: circleId,
        deleted: false,
        OR: [
          { ownerID: userId },
          { members: { some: { userID: userId, status: 'ACTIVE' } } },
        ],
      },
      select: { id: true, name: true, cities: true },
    });
  }

  private async requireAccessibleCircle(
    userId: string,
    circleId: string,
  ): Promise<AccessibleCircle> {
    const circle = await this.findAccessibleCircle(userId, circleId);
    if (!circle) {
      throw new ForbiddenException('只能订阅已加入的圈子信息');
    }
    return circle;
  }

  private validateSelectedCities(
    requested: string[] | undefined,
    circleCities: string[],
  ): string[] {
    const cities = this.normalizeList(requested ?? []);
    if (cities.length === 0) return [];
    const allowed = new Set(this.normalizeList(circleCities));
    if (allowed.size === 0 || cities.some((city) => !allowed.has(city))) {
      throw new BadRequestException('订阅城市必须来自当前圈子的城市范围');
    }
    return cities;
  }

  private toDto(row: SubscriptionWithCircle): AssistantSubscriptionDto {
    const circleCities = this.normalizeList(row.circle.cities);
    const selectedCities = this.normalizeList(row.cities);
    return {
      id: row.id,
      circleId: row.circleID,
      circleName: row.circle.name,
      circleCities,
      cities: selectedCities.length > 0 ? selectedCities : circleCities,
      keywords: this.normalizeKeywords(row.keywords),
      followsCircleCities: selectedCities.length === 0,
      sourceTypes: row.sourceTypes,
      enabled: row.enabled,
      pushEnabled: row.pushEnabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private normalizeList(values: readonly string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }

  private normalizeKeywords(values: readonly string[] | undefined): string[] {
    return this.normalizeList(values ?? []).slice(0, 20);
  }

  private matchesKeywords(
    post: { content: string; tags: string[] },
    keywords: readonly string[],
  ): boolean {
    const normalized = this.normalizeKeywords(keywords).map((value) =>
      value.toLocaleLowerCase(),
    );
    if (normalized.length === 0) return true;
    const haystack = [post.content, ...post.tags]
      .join('\n')
      .toLocaleLowerCase();
    return normalized.some((keyword) => haystack.includes(keyword));
  }

  private firstLine(value: string): string {
    return this.clamp(value.split(/\r?\n/, 1)[0]?.trim() ?? '', 80);
  }

  private clamp(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }
}

export type { InfoAlertPayload };
