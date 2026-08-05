import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Timeout } from '@nestjs/schedule';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';

const GROUP_PRIVACY_PAGE_SIZE = 100;
/** AllowType.NotAllowed —— 目录仅群主/管理员可见。 */
const NOT_ALLOWED = 1;
/** OpenIM 群状态：2 = 已解散（set_group_info 会报 ErrDismissedAlready）。 */
const GROUP_STATUS_DISMISSED = 2;
/**
 * 扫描持有跨副本 advisory 锁运行；页数不设上限但受 OpenIM 目录规模约束，
 * 给事务留足窗口，超时后锁随事务释放、下一轮重试。
 */
const BACKFILL_LOCK_TX_TIMEOUT_MS = 15 * 60_000;

/**
 * 存量群成员目录隐私 backfill（review P1）。
 *
 * 新群在创建时就带 lookMemberInfo/applyMemberFriend=NotAllowed，但发布前建的群
 * （以及灰度期旧客户端新建的群）在 OpenIM 侧仍是全员可读目录——老客户端或直连
 * SDK 都绕得开新客户端的 UI 门禁。这里在服务端分页扫描全部群并补齐两个标志：
 * 启动后先跑一轮，之后每小时对账一次；幂等（已收紧的群只读不写），单次失败
 * 留给下一轮收敛，不依赖管理员打开 App。
 *
 * review R2：多副本部署下用 Postgres advisory 锁（与 like-reconciliation 同
 * 模式）保证同一时刻只有一个副本在扫描，其余副本拿不到锁直接跳过本轮，
 * 避免每个 pod 都全量扫目录、按副本数放大 OpenIM 负载。
 */
@Injectable()
export class GroupPrivacyBackfillProcessor {
  private readonly logger = new Logger(GroupPrivacyBackfillProcessor.name);
  /** 进程内防重入（同副本上 startup timeout 与 cron 可能相邻触发）。 */
  private running = false;

  constructor(
    private readonly openimService: OpenimService,
    private readonly prisma: PrismaService,
  ) {}

  @Timeout(30_000)
  async runAfterBoot(): Promise<void> {
    await this.reconcile();
  }

  @Cron(CronExpression.EVERY_HOUR)
  async reconcile(): Promise<void> {
    if (!this.openimService.isEnabled()) return;
    if (this.running) return;
    this.running = true;

    try {
      await this.prisma.$transaction(
        async (tx) => {
          const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
            SELECT pg_try_advisory_xact_lock(hashtextextended('group-privacy-backfill', 0)) AS acquired
          `;
          if (!lock?.acquired) return;
          await this.scanAndEnforce();
        },
        { timeout: BACKFILL_LOCK_TX_TIMEOUT_MS },
      );
    } catch (error) {
      this.logger.warn(
        `Group privacy backfill scan aborted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.running = false;
    }
  }

  private async scanAndEnforce(): Promise<void> {
    let scanned = 0;
    let enforced = 0;
    let failed = 0;

    const first = await this.openimService.listGroups({
      page: 1,
      limit: GROUP_PRIVACY_PAGE_SIZE,
    });
    const totalPages = Math.max(
      1,
      Math.ceil(first.total / GROUP_PRIVACY_PAGE_SIZE),
    );

    for (let page = 1; page <= totalPages; page += 1) {
      const batch =
        page === 1
          ? first
          : await this.openimService.listGroups({
              page,
              limit: GROUP_PRIVACY_PAGE_SIZE,
            });
      const groups = batch.groups ?? [];
      if (groups.length === 0) break;

      for (const group of groups) {
        const info = group.groupInfo;
        scanned += 1;
        if (info.status === GROUP_STATUS_DISMISSED) continue;
        if (
          info.lookMemberInfo === NOT_ALLOWED &&
          info.applyMemberFriend === NOT_ALLOWED
        ) {
          continue;
        }
        try {
          await this.openimService.enforceGroupMemberPrivacy(info.groupID);
          enforced += 1;
        } catch (error) {
          failed += 1;
          this.logger.warn(
            `Group privacy backfill failed for group ${info.groupID}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    if (enforced > 0 || failed > 0) {
      this.logger.log(
        `Group privacy backfill: scanned=${scanned} enforced=${enforced} failed=${failed}`,
      );
    }
  }
}
