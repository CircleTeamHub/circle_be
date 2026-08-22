import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  reportHandledJobFailure,
  reportJobSkipped,
  TrackedCron,
} from '../metrics/tracked-cron.decorator';
import { reportOperationalError } from 'src/logging/error-aggregation.service';
import { QrLoginService } from './qr-login.service';

/**
 * 扫码登录会话的保留期清理。
 *
 * 每次「打开网页登录页」都会匿名插一行，而登录成功与否都不删 —— 没有这个
 * 清理，QrLoginSession 和它的两个唯一索引会随正常流量单调增长，刷二维码
 * 的人越多长得越快。行本身极小，按小时扫一次足够。
 */
@Injectable()
export class QrLoginCleanup {
  private readonly logger = new Logger(QrLoginCleanup.name);
  /** 重入闸：上一轮没回来时不叠第二轮全表扫描。 */
  private running = false;

  constructor(private readonly qrLoginService: QrLoginService) {}

  @TrackedCron(CronExpression.EVERY_HOUR, 'qr_login_cleanup')
  async sweep(): Promise<void> {
    if (this.running) {
      reportJobSkipped();
      return;
    }
    this.running = true;
    try {
      const { count } = await this.qrLoginService.purgeExpired();
      if (count > 0) {
        this.logger.log(`purged ${count} expired qr-login sessions`);
      }
    } catch (error) {
      reportOperationalError(error, {
        component: 'QrLoginCleanup',
        operation: 'purgeExpired',
        kind: 'scheduler',
      });
      this.logger.error(
        `qr-login purge failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      reportHandledJobFailure();
    } finally {
      this.running = false;
    }
  }
}
