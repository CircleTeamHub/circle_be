import { createHash } from 'crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConsoleRelease, ConsoleReleasePlan } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { TtlCache } from 'src/utils/ttl-cache';
import {
  runAdminOperation,
  writeOperationAudit,
} from 'src/admin-operations/admin-operation-request';
import { decideUpdate, validatePlan, validateRelease } from './console-policy';
import type {
  ReasonDto,
  AdminUpdatePreviewQuery,
  ReleaseDto,
  ReleasePlanDto,
  UpdateDecisionQuery,
} from './console.dto';

type DecisionPlan = ConsoleReleasePlan & { release: ConsoleRelease };

/**
 * GET /app-operations/update 匿名、每次 App 启动都调,同一 (platform, channel, build)
 * 的所有设备查到的计划完全相同:计划查询进程内缓存 30 秒。灰度分桶(installation)
 * 和时间窗仍由 decideUpdate 按每个请求的入参与当前时间判断,缓存的只是候选计划。
 * 本进程的发版写入(create / withdraw / plan)提交后立即清缓存;别的实例最多晚
 * 30 秒看到 —— 包括撤回。管理台预览(preview)不走缓存。
 */
export const UPDATE_DECISION_CACHE_TTL_MS = 30_000;
/** build 是匿名入参,可被随意枚举;条目数封顶,防止缓存被刷大。 */
const UPDATE_DECISION_CACHE_MAX_ENTRIES = 256;

@Injectable()
export class ConsoleReleasesService {
  private readonly decisionPlans = new TtlCache<DecisionPlan[]>({
    ttlMs: UPDATE_DECISION_CACHE_TTL_MS,
    maxEntries: UPDATE_DECISION_CACHE_MAX_ENTRIES,
  });

  constructor(private readonly prisma: PrismaService) {}
  async list() {
    const [releases, plans, versions] = await Promise.all([
      this.prisma.consoleRelease.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.consoleReleasePlan.findMany({
        include: { release: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.appInstallation.groupBy({
        by: ['platform', 'channel', 'appVersion', 'build'],
        where: { lastSeenAt: { gte: new Date(Date.now() - 30 * 86400_000) } },
        _count: true,
      }),
    ]);
    return { releases, plans, versions, versionWindowDays: 30 };
  }
  create(actorID: string, dto: ReleaseDto, key?: string) {
    validateRelease(dto);
    const writing = runAdminOperation(
      this.prisma,
      actorID,
      'release.create',
      key,
      dto,
      async (tx) => {
        const { reason, ...data } = dto;
        const release = await tx.consoleRelease.create({ data });
        await writeOperationAudit(
          tx,
          actorID,
          'console.release.create',
          'release',
          release.id,
          reason,
        );
        return release;
      },
    );
    return this.invalidatingDecisions(writing);
  }
  withdraw(actorID: string, id: string, dto: ReasonDto, key?: string) {
    const writing = runAdminOperation(
      this.prisma,
      actorID,
      'release.withdraw',
      key,
      { id, ...dto },
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ConsoleRelease" WHERE id=${id} FOR UPDATE`;
        const release = await tx.consoleRelease.findUnique({ where: { id } });
        if (!release) throw new NotFoundException('版本不存在');
        const result = await tx.consoleRelease.update({
          where: { id },
          data: { withdrawnAt: release.withdrawnAt ?? new Date() },
        });
        await writeOperationAudit(
          tx,
          actorID,
          'console.release.withdraw',
          'release',
          id,
          dto.reason,
        );
        return result;
      },
    );
    return this.invalidatingDecisions(writing);
  }
  plan(
    actorID: string,
    id: string | undefined,
    dto: ReleasePlanDto,
    key?: string,
  ) {
    const writing = runAdminOperation(
      this.prisma,
      actorID,
      'release.plan',
      key,
      { id, ...dto },
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ConsoleRelease" WHERE id=${dto.releaseID} FOR UPDATE`;
        const release = await tx.consoleRelease.findUnique({
          where: { id: dto.releaseID },
        });
        if (!release) throw new NotFoundException('版本不存在');
        validatePlan(dto, release);
        const { reason, version, ...fields } = dto;
        const data = {
          ...fields,
          startsAt: new Date(dto.startsAt),
          endsAt: new Date(dto.endsAt),
        };
        if (id) {
          const result = await tx.consoleReleasePlan.updateMany({
            where: { id, version: version ?? 0 },
            data: { ...data, version: { increment: 1 } },
          });
          if (!result.count)
            throw new ConflictException('更新计划已变化，请刷新');
        }
        const plan = id
          ? await tx.consoleReleasePlan.findUniqueOrThrow({ where: { id } })
          : await tx.consoleReleasePlan.create({ data });
        await writeOperationAudit(
          tx,
          actorID,
          'console.release.plan',
          'release_plan',
          plan.id,
          reason,
          undefined,
          {
            releaseID: dto.releaseID,
            rollout: dto.rollout,
            forceBelow: dto.forceBelow,
            enabled: dto.enabled,
          },
        );
        return plan;
      },
    );
    return this.invalidatingDecisions(writing);
  }
  async preview(input: AdminUpdatePreviewQuery) {
    if (!input.installationID) return this.freshDecision(input);
    const installed = await this.prisma.appInstallation.findUnique({
      where: { id: input.installationID },
    });
    if (!installed || !['android', 'ios'].includes(installed.platform))
      throw new NotFoundException('没有找到原生设备版本登记');
    const client = {
      platform: installed.platform,
      channel: installed.channel,
      build: installed.build,
      installation: createHash('sha256')
        .update(`circle-release:${installed.deviceKey}`)
        .digest('hex'),
    };
    return {
      ...(await this.freshDecision(client)),
      evaluatedClient: {
        installationID: installed.id,
        platform: client.platform,
        channel: client.channel,
        build: client.build,
        lastSeenAt: installed.lastSeenAt,
      },
    };
  }
  async decision(input: UpdateDecisionQuery) {
    const plans = await this.decisionPlans.getOrLoad(
      `${input.platform}|${input.channel}|${input.build}`,
      () => this.loadDecisionPlans(input, new Date()),
    );
    return decideUpdate(plans, input, new Date());
  }

  private async freshDecision(input: UpdateDecisionQuery) {
    const now = new Date();
    return decideUpdate(await this.loadDecisionPlans(input, now), input, now);
  }

  private loadDecisionPlans(
    input: UpdateDecisionQuery,
    now: Date,
  ): Promise<DecisionPlan[]> {
    return this.prisma.consoleReleasePlan.findMany({
      where: {
        enabled: true,
        startsAt: { lte: now },
        endsAt: { gt: now },
        release: {
          platform: input.platform,
          channel: input.channel,
          withdrawnAt: null,
        },
        minBuild: { lte: input.build },
        maxBuild: { gte: input.build },
      },
      include: { release: true },
      take: 100,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** 写入提交(或结果不明的失败)之后立刻丢掉更新决策缓存。 */
  private invalidatingDecisions<T>(writing: Promise<T>): Promise<T> {
    return writing.finally(() => this.decisionPlans.clear());
  }
}
