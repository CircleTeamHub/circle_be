import { randomUUID } from 'crypto';
import { CoinService } from 'src/coin/coin.service';
import { WalletReconciliationService } from 'src/coin/wallet-reconciliation.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { getE2eApp } from './e2e-context';

function canRunPostgresE2e(): boolean {
  const databaseUrl = process.env.DATABASE_URL;
  if (process.env.NODE_ENV !== 'test' || !databaseUrl || !process.env.SECRET) {
    return false;
  }

  try {
    const url = new URL(databaseUrl);
    const databaseName = decodeURIComponent(url.pathname.slice(1));
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      /(^|[_-])test($|[_-])/i.test(databaseName)
    );
  } catch {
    return false;
  }
}

const describePostgres = canRunPostgresE2e() ? describe : describe.skip;

/**
 * 对账 SQL 对着真实 Postgres 跑：真实的入账、送礼路径写出来的数据必须对得上
 * （否则告警第一天就会对着正常数据响），而三种坏数据必须各被数到一次。
 *
 * 共享测试库里别的用例可能留下自己的钱包，所以这里只比「本用例前后的差值」。
 */
describePostgres('Wallet reconciliation e2e', () => {
  let prisma: PrismaService;
  let coins: CoinService;
  let reconciliation: WalletReconciliationService;

  const createUser = async (label: string) => {
    const id = randomUUID();
    const suffix = id.replace(/-/g, '').slice(0, 10);
    return prisma.user.create({
      data: {
        id,
        accountId: `${label}-${suffix}`,
        inviteCode: suffix.slice(0, 6),
        passwordHash: 'not-used',
        nickname: `${label} ${suffix}`,
      },
    });
  };

  // setup-jest.ts 每个用例前重建应用，服务实例也要跟着每次重新取。
  beforeEach(() => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    coins = app.get(CoinService);
    reconciliation = app.get(WalletReconciliationService);
  });

  it('agrees with every ledger the real credit and gift paths write', async () => {
    const baseline = await reconciliation.reconcile();
    const sender = await createUser('recon-sender');
    const recipient = await createUser('recon-recipient');
    await prisma.friend.create({
      data: { userID: sender.id, friendID: recipient.id, state: 'ACCEPTED' },
    });

    for (const amount of [40, 25]) {
      await prisma.$transaction((tx) =>
        coins.creditInTransaction(tx, {
          userId: sender.id,
          amount,
          type: 'REFERRAL_REWARD',
          note: 'reconciliation e2e',
          relatedId: randomUUID(),
          idempotencyKey: `recon-e2e:${randomUUID()}`,
        }),
      );
    }
    await coins.sendGift(
      sender.id,
      recipient.id,
      30,
      `recon-e2e:${randomUUID()}`,
    );

    const after = await reconciliation.reconcile();
    expect(after.wallets).toBe(baseline.wallets + 2);
    expect(after.ledgerMismatches).toBe(baseline.ledgerMismatches);
    expect(after.negativeBalances).toBe(baseline.negativeBalances);
  });

  it('counts a balance changed without a ledger row, a negative balance and a ledger without a wallet', async () => {
    const baseline = await reconciliation.reconcile();

    // 改了余额却没记流水。
    const drifted = await createUser('recon-drift');
    await prisma.wallet.create({ data: { userID: drifted.id, balance: 15 } });
    await prisma.coinTransaction.create({
      data: { userID: drifted.id, type: 'RECHARGE', amount: 10, balance: 10 },
    });

    // 流水与余额一致，但余额是负的：扣款的 balance >= amount 条件被绕过了。
    const negative = await createUser('recon-negative');
    await prisma.wallet.create({ data: { userID: negative.id, balance: -3 } });
    await prisma.coinTransaction.create({
      data: { userID: negative.id, type: 'PURCHASE', amount: -3, balance: -3 },
    });

    // 有流水、没有钱包行。
    const orphan = await createUser('recon-orphan');
    await prisma.coinTransaction.create({
      data: { userID: orphan.id, type: 'RECHARGE', amount: 7, balance: 7 },
    });

    // 没有任何流水、余额为 0 的新钱包是正常的。
    const fresh = await createUser('recon-fresh');
    await coins.getWallet(fresh.id);

    const after = await reconciliation.reconcile();
    expect(after.wallets).toBe(baseline.wallets + 4);
    expect(after.ledgerMismatches).toBe(baseline.ledgerMismatches + 2);
    expect(after.negativeBalances).toBe(baseline.negativeBalances + 1);
  });
});
