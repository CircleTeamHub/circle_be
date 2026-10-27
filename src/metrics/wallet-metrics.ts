import { Gauge, Registry } from 'prom-client';

export const WALLET_RECONCILIATION_CHECKS = [
  'ledger_mismatch',
  'negative_balance',
] as const;

export type WalletReconciliationCheck =
  (typeof WALLET_RECONCILIATION_CHECKS)[number];

export interface WalletReconciliationResult {
  /** 参与核对的钱包数（含只有流水、没有钱包行的用户）。 */
  wallets: number;
  /** 余额 ≠ 该用户全部流水金额之和的钱包数。 */
  ledgerMismatches: number;
  /** 余额为负的钱包数。扣款都带 `balance >= amount` 条件，负数说明有写入绕过了它。 */
  negativeBalances: number;
}

export interface WalletMetrics {
  readonly registry: Registry;
  recordReconciliation(result: WalletReconciliationResult): void;
}

/**
 * 钱包对账的结果（WalletReconciliationService 每天跑一次）。
 *
 * 余额和流水在同一个事务里写，正常情况下 `Wallet.balance` 恒等于该用户
 * `CoinTransaction.amount` 之和。不相等只可能是有路径只改了一边：漏记流水、
 * 手工改库、并发写坏。这类错误不报错、不影响接口，用户看到的余额就是错的，
 * 而越晚发现越难从流水里追回来 —— WalletLedgerMismatch 读的就是这里。
 *
 * 不播种成 0：没跑过对账时不知道结果，不能冒充「一致」。告警用 last_over_time
 * 读最近一次结果，进程重启后序列暂时消失也不会让告警误恢复。
 */
export function createWalletMetrics(): WalletMetrics {
  const registry = new Registry();
  const violations = new Gauge({
    name: 'circle_wallet_reconciliation_violations',
    help: 'Wallets failing each check in the last wallet reconciliation run.',
    labelNames: ['check'],
    registers: [registry],
  });
  const wallets = new Gauge({
    name: 'circle_wallet_reconciliation_wallets',
    help: 'Wallets (and ledger-only users) covered by the last reconciliation run.',
    registers: [registry],
  });

  return {
    registry,
    recordReconciliation(result) {
      violations.set({ check: 'ledger_mismatch' }, result.ledgerMismatches);
      violations.set({ check: 'negative_balance' }, result.negativeBalances);
      wallets.set(result.wallets);
    },
  };
}

export const walletMetrics = createWalletMetrics();
