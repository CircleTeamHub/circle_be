import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { reportOperationalError } from 'src/logging/error-aggregation.service';
import {
  reportHandledJobFailure,
  TrackedCron,
} from 'src/metrics/tracked-cron.decorator';
import {
  walletMetrics,
  type WalletReconciliationResult,
} from 'src/metrics/wallet-metrics';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * 全表聚合流水，所以事务里把语句超时放宽到 60s（请求路径默认 15s）；仍有上限，
 * 不会无限占着连接。事务超时比它略长，让语句超时先触发、报出真实原因。
 */
const RECONCILIATION_TRANSACTION_TIMEOUT_MS = 70_000;

interface ReconciliationRow {
  wallets: number;
  ledgerMismatches: number;
  negativeBalances: number;
}

/**
 * 每天核对一次：每个钱包的余额是否等于该用户全部流水金额之和、有没有负余额。
 *
 * 只比总和，不比「最后一条流水记下的余额」：流水的 createdAt 取的是事务开始
 * 时刻，两笔并发扣款提交顺序与 createdAt 顺序可以相反，按时间取「最后一条」
 * 会在完全正常的数据上报错。总和与顺序无关。
 *
 * 一条 SQL 读完钱包和流水，两边看到的是同一个快照：对账期间新提交的转账要么
 * 两边都在、要么都不在，不会因为读的先后报出假的不一致。只读事务，不改任何
 * 数据；有问题只出指标和计数日志，不记用户 ID —— 定位用手册里的查询。
 *
 * 只读、幂等，蓝绿重叠时两个实例各跑一次也无害，所以不加租约。
 */
@Injectable()
export class WalletReconciliationService {
  private readonly logger = new Logger(WalletReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  @TrackedCron(CronExpression.EVERY_DAY_AT_5AM, 'wallet_reconciliation')
  async runScheduled(): Promise<void> {
    try {
      const result = await this.reconcile();
      walletMetrics.recordReconciliation(result);
      if (result.ledgerMismatches > 0 || result.negativeBalances > 0) {
        this.logger.error({
          event: 'wallet_reconciliation_mismatch',
          ...result,
        });
      } else {
        this.logger.log({ event: 'wallet_reconciliation_ok', ...result });
      }
    } catch (error) {
      reportOperationalError(error, {
        component: 'WalletReconciliationService',
        operation: 'reconcile',
        kind: 'scheduler',
      });
      this.logger.error(
        `wallet reconciliation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      reportHandledJobFailure();
    }
  }

  async reconcile(): Promise<WalletReconciliationResult> {
    const rows = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '60s'`;
        return tx.$queryRaw<ReconciliationRow[]>`
          WITH ledger AS (
            SELECT "userID", SUM("amount")::bigint AS total
            FROM "CoinTransaction"
            GROUP BY "userID"
          )
          SELECT
            COUNT(*)::int AS "wallets",
            COUNT(*) FILTER (
              WHERE COALESCE(w."balance", 0)::bigint <> COALESCE(l.total, 0)
            )::int AS "ledgerMismatches",
            COUNT(*) FILTER (WHERE w."balance" < 0)::int AS "negativeBalances"
          FROM "Wallet" w
          FULL OUTER JOIN ledger l ON l."userID" = w."userID"
        `;
      },
      { maxWait: 10_000, timeout: RECONCILIATION_TRANSACTION_TIMEOUT_MS },
    );
    const row = rows[0];
    return {
      wallets: Number(row?.wallets ?? 0),
      ledgerMismatches: Number(row?.ledgerMismatches ?? 0),
      negativeBalances: Number(row?.negativeBalances ?? 0),
    };
  }
}
