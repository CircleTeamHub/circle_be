import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Timeout } from '@nestjs/schedule';
import { OpenimService } from 'src/openim/openim.service';

const GROUP_PRIVACY_PAGE_SIZE = 100;
/** AllowType.NotAllowed —— 目录仅群主/管理员可见。 */
const NOT_ALLOWED = 1;
/** OpenIM 群状态：2 = 已解散（set_group_info 会报 ErrDismissedAlready）。 */
const GROUP_STATUS_DISMISSED = 2;

/**
 * 存量群成员目录隐私 backfill（review P1）。
 *
 * 新群在创建时就带 lookMemberInfo/applyMemberFriend=NotAllowed，但发布前建的群
 * （以及灰度期旧客户端新建的群）在 OpenIM 侧仍是全员可读目录——老客户端或直连
 * SDK 都绕得开新客户端的 UI 门禁。这里在服务端分页扫描全部群并补齐两个标志：
 * 启动后先跑一轮，之后每小时对账一次；幂等（已收紧的群只读不写），单次失败
 * 留给下一轮收敛，不依赖管理员打开 App。
 */
@Injectable()
export class GroupPrivacyBackfillProcessor {
  private readonly logger = new Logger(GroupPrivacyBackfillProcessor.name);
  private running = false;

  constructor(private readonly openimService: OpenimService) {}

  @Timeout(30_000)
  async runAfterBoot(): Promise<void> {
    await this.reconcile();
  }

  @Cron(CronExpression.EVERY_HOUR)
  async reconcile(): Promise<void> {
    if (!this.openimService.isEnabled()) return;
    if (this.running) return;
    this.running = true;

    let scanned = 0;
    let enforced = 0;
    let failed = 0;
    try {
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
    } catch (error) {
      this.logger.warn(
        `Group privacy backfill scan aborted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    } finally {
      this.running = false;
    }

    if (enforced > 0 || failed > 0) {
      this.logger.log(
        `Group privacy backfill: scanned=${scanned} enforced=${enforced} failed=${failed}`,
      );
    }
  }
}
