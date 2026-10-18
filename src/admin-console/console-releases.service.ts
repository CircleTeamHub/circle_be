import { createHash } from 'crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
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

@Injectable()
export class ConsoleReleasesService {
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
    return runAdminOperation(
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
  }
  withdraw(actorID: string, id: string, dto: ReasonDto, key?: string) {
    return runAdminOperation(
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
  }
  plan(
    actorID: string,
    id: string | undefined,
    dto: ReleasePlanDto,
    key?: string,
  ) {
    return runAdminOperation(
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
  }
  async preview(input: AdminUpdatePreviewQuery) {
    if (!input.installationID) return this.decision(input);
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
      ...(await this.decision(client)),
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
    const now = new Date();
    const plans = await this.prisma.consoleReleasePlan.findMany({
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
    return decideUpdate(plans, input, now);
  }
}
