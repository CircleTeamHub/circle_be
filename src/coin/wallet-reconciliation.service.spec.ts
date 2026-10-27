import * as errorAggregation from 'src/logging/error-aggregation.service';
import { jobMetrics } from 'src/metrics/job-metrics';
import { createWalletMetrics, walletMetrics } from 'src/metrics/wallet-metrics';
import { WalletReconciliationService } from './wallet-reconciliation.service';

function prismaReturning(row: unknown) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([row]),
  };
  const prisma = {
    $transaction: jest.fn(
      async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    ),
  };
  return { prisma, tx };
}

function sqlOf(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?');
}

describe('WalletReconciliationService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads wallets and the ledger in one read-only statement and records the counts', async () => {
    const { prisma, tx } = prismaReturning({
      wallets: 12,
      ledgerMismatches: 0,
      negativeBalances: 0,
    });
    const record = jest.spyOn(walletMetrics, 'recordReconciliation');
    const service = new WalletReconciliationService(prisma as any);

    await service.runScheduled();

    // 只读事务 + 一条查询：钱包和流水来自同一个快照，对账期间提交的转账不会
    // 只出现在一边而报出假的不一致。
    expect(sqlOf(tx.$executeRaw.mock.calls[0])).toBe(
      'SET TRANSACTION READ ONLY',
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = sqlOf(tx.$queryRaw.mock.calls[0]);
    expect(sql).toContain('FULL OUTER JOIN ledger');
    expect(sql).toContain('SUM("amount")');
    expect(record).toHaveBeenCalledWith({
      wallets: 12,
      ledgerMismatches: 0,
      negativeBalances: 0,
    });
  });

  it('logs counts only — never user identifiers — when wallets disagree with the ledger', async () => {
    const { prisma } = prismaReturning({
      wallets: 12,
      ledgerMismatches: 2,
      negativeBalances: 1,
    });
    const service = new WalletReconciliationService(prisma as any);
    const error = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    await service.runScheduled();

    expect(error).toHaveBeenCalledWith({
      event: 'wallet_reconciliation_mismatch',
      wallets: 12,
      ledgerMismatches: 2,
      negativeBalances: 1,
    });
  });

  it('counts a failed run as a job failure without throwing or recording a result', async () => {
    const prisma = {
      $transaction: jest
        .fn()
        .mockRejectedValue(
          new Error('canceling statement due to statement timeout'),
        ),
    };
    const record = jest.spyOn(walletMetrics, 'recordReconciliation');
    const report = jest
      .spyOn(errorAggregation, 'reportOperationalError')
      .mockImplementation(() => undefined);
    const recordRun = jest.spyOn(jobMetrics, 'recordRun');
    const service = new WalletReconciliationService(prisma as any);
    jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    await expect(service.runScheduled()).resolves.toBeUndefined();

    expect(record).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.any(Error), {
      component: 'WalletReconciliationService',
      operation: 'reconcile',
      kind: 'scheduler',
    });
    // 失败要进 CronJobFailing：吞掉异常正常返回的任务必须自己报失败。
    expect(recordRun).toHaveBeenCalledWith(
      'wallet_reconciliation',
      'failure',
      expect.any(Number),
      undefined,
    );
  });
});

describe('createWalletMetrics', () => {
  it('exports nothing until a reconciliation has actually run', async () => {
    const metrics = createWalletMetrics();

    const output = await metrics.registry.metrics();
    expect(output).not.toMatch(/circle_wallet_reconciliation_violations\{/);
  });

  it('exports one series per check plus the wallet count', async () => {
    const metrics = createWalletMetrics();

    metrics.recordReconciliation({
      wallets: 30,
      ledgerMismatches: 2,
      negativeBalances: 0,
    });

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /circle_wallet_reconciliation_violations\{check="ledger_mismatch"\} 2/,
    );
    expect(output).toMatch(
      /circle_wallet_reconciliation_violations\{check="negative_balance"\} 0/,
    );
    expect(output).toMatch(/circle_wallet_reconciliation_wallets 30/);
  });
});
