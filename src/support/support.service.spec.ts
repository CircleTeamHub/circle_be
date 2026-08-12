import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminUserAuditService } from 'src/admin-user/admin-user-audit.service';
import { SUPPORT_AGENTS_MAX } from './support.dto';
import {
  REPLACE_TRANSACTION_TIMEOUT_MS,
  SUPPORT_AGENTS_AUDIT_TARGET_ID,
  SupportService,
  supportAgentsRevision,
} from './support.service';

const user = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  nickname: `nick-${id}`,
  avatarUrl: null,
  vipLevel: 0,
  ...overrides,
});

describe('SupportService', () => {
  const tx = {
    $executeRaw: jest.fn(),
    supportAgent: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
    },
  };
  type TxCallback = (client: typeof tx) => Promise<unknown>;
  const runTransaction: (
    callback: TxCallback,
    options?: { timeout?: number },
  ) => Promise<unknown> = (callback) => callback(tx);
  const prisma = {
    supportAgent: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    user: { findMany: jest.fn() },
    $transaction: jest.fn(runTransaction),
  };
  const audit = { recordInTransaction: jest.fn(), listForTarget: jest.fn() };
  const service = new SupportService(
    prisma as unknown as PrismaService,
    audit as unknown as AdminUserAuditService,
  );
  const operator = { userId: 'admin-1', accountId: 'admin-account' };

  beforeEach(() => jest.clearAllMocks());

  describe('getConfig', () => {
    it('groups agents by category and always returns all five keys', async () => {
      prisma.supportAgent.findMany.mockResolvedValue([
        { category: 'recharge', user: user('u1') },
        { category: 'recharge', user: user('u2') },
        { category: 'membership', user: user('u3') },
      ]);

      const { agents } = await service.getConfig();

      expect(agents.recharge.map((a) => a.userID)).toEqual(['u1', 'u2']);
      expect(agents.membership.map((a) => a.userID)).toEqual(['u3']);
      // 未配置的类必须是空数组而不是 undefined —— App 直接渲染空态。
      expect(agents.issue).toEqual([]);
      expect(agents.dispute).toEqual([]);
      expect(agents.account).toEqual([]);
    });

    // 账号被封/注销却仍出现在列表里,就回到了 imAdmin 时代「渲染成功、点击失败」的老毛病。
    it('asks the database for enabled rows whose user is still ACTIVE, ordered by sortOrder', async () => {
      prisma.supportAgent.findMany.mockResolvedValue([]);

      await service.getConfig();

      const args = prisma.supportAgent.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ enabled: true, user: { status: 'ACTIVE' } });
      expect(args.orderBy).toContainEqual({ sortOrder: 'asc' });
    });
  });

  describe('listForAdminWithRevision', () => {
    // agents 与 revision 必须来自同一次查询。分成两条独立查询时,期间若有别人提交
    // 成功,就可能返回「旧 agents + 新 revision」—— 这份陈旧列表随后能通过冲突校验,
    // 把更新的配置覆盖掉,正是 revision 想拦的事。
    it('derives both the list and the revision from a single query', async () => {
      const rows = [
        {
          category: 'recharge',
          userID: 'u1',
          sortOrder: 0,
          enabled: true,
          user: user('u1'),
        },
      ];
      prisma.supportAgent.findMany.mockResolvedValue(rows);

      const result = await service.listForAdminWithRevision();

      expect(prisma.supportAgent.findMany).toHaveBeenCalledTimes(1);
      expect(result.agents.map((a) => a.userID)).toEqual(['u1']);
      expect(result.revision).toBe(
        supportAgentsRevision([
          { category: 'recharge', userID: 'u1', sortOrder: 0, enabled: true },
        ]),
      );
    });
  });

  describe('replaceAgents', () => {
    const activeUsers = (ids: string[]) =>
      prisma.user.findMany.mockResolvedValue(
        ids.map((id) => ({ id, status: 'ACTIVE' })),
      );

    // 当前库里的行。findMany 从它读,replace() 也从它算 expectedRevision ——
    // 这样各用例只需声明「库里现在有什么」,不必手工维护一个哈希。
    let beforeRows: Record<string, unknown>[] = [];
    const replace = (input: Parameters<typeof service.replaceAgents>[1]) =>
      service.replaceAgents(
        operator,
        input,
        supportAgentsRevision(beforeRows as never),
      );

    beforeEach(() => {
      beforeRows = [];
      tx.supportAgent.findMany.mockImplementation(() =>
        Promise.resolve(beforeRows),
      );
      prisma.supportAgent.findMany.mockResolvedValue([]);
    });

    it('rejects a user that does not exist', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await expect(
        replace([{ category: 'recharge', userID: 'ghost', sortOrder: 0 }]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each(['BANNED', 'DELETED'])('rejects a %s user', async (status) => {
      prisma.user.findMany.mockResolvedValue([{ id: 'u1', status }]);

      await expect(
        replace([{ category: 'recharge', userID: 'u1', sortOrder: 0 }]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects the same user twice in one category', async () => {
      activeUsers(['u1']);

      await expect(
        replace([
          { category: 'recharge', userID: 'u1', sortOrder: 0 },
          { category: 'recharge', userID: 'u1', sortOrder: 1 },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allows the same user in two different categories', async () => {
      activeUsers(['u1']);

      await replace([
        { category: 'recharge', userID: 'u1', sortOrder: 0 },
        { category: 'dispute', userID: 'u1', sortOrder: 0 },
      ]);

      expect(tx.supportAgent.createMany).toHaveBeenCalledTimes(1);
      expect(tx.supportAgent.createMany.mock.calls[0][0].data).toEqual([
        { category: 'recharge', userID: 'u1', sortOrder: 0, enabled: true },
        { category: 'dispute', userID: 'u1', sortOrder: 0, enabled: true },
      ]);
    });

    // 覆盖式写入的语义:没出现在 payload 里的行才删。已存在的行走 update 而不是
    // 整表 deleteMany+createMany,否则调一次顺序就让所有行看起来像刚创建。
    it('deletes only the rows missing from the payload and updates the rest in place', async () => {
      activeUsers(['u1']);
      beforeRows = [
        { category: 'recharge', userID: 'u1', sortOrder: 0, enabled: true },
        { category: 'issue', userID: 'gone', sortOrder: 0, enabled: true },
      ];

      await replace([{ category: 'recharge', userID: 'u1', sortOrder: 5 }]);

      expect(tx.supportAgent.deleteMany).toHaveBeenCalledWith({
        where: { OR: [{ category: 'issue', userID: 'gone' }] },
      });
      expect(tx.supportAgent.createMany).not.toHaveBeenCalled();
      expect(tx.supportAgent.update).toHaveBeenCalledTimes(1);
      expect(tx.supportAgent.update.mock.calls[0][0]).toEqual({
        where: { category_userID: { category: 'recharge', userID: 'u1' } },
        data: { sortOrder: 5, enabled: true },
      });
    });

    // 停用要靠 enabled=false 传进来,而不是从 payload 里省略 —— 省略等于删除。
    it('keeps a disabled row instead of deleting it', async () => {
      activeUsers(['u1']);

      await replace([
        { category: 'recharge', userID: 'u1', sortOrder: 0, enabled: false },
      ]);

      expect(tx.supportAgent.deleteMany).not.toHaveBeenCalled();
      expect(tx.supportAgent.createMany.mock.calls[0][0].data).toEqual([
        { category: 'recharge', userID: 'u1', sortOrder: 0, enabled: false },
      ]);
    });

    // 「只挪一行顺序」不该重写整张表:没变的行连一次 update 都不该发出去,
    // 否则满额 payload 每次保存都是 200 次串行往返,updatedAt 也全被刷成本次。
    it('skips rows whose sortOrder and enabled are unchanged', async () => {
      activeUsers(['u1', 'u2']);
      beforeRows = [
        { category: 'recharge', userID: 'u1', sortOrder: 0, enabled: true },
        { category: 'recharge', userID: 'u2', sortOrder: 1, enabled: true },
      ];

      await replace([
        { category: 'recharge', userID: 'u1', sortOrder: 0 },
        { category: 'recharge', userID: 'u2', sortOrder: 9 },
      ]);

      expect(tx.supportAgent.createMany).not.toHaveBeenCalled();
      expect(tx.supportAgent.update).toHaveBeenCalledTimes(1);
      expect(tx.supportAgent.update.mock.calls[0][0].where).toEqual({
        category_userID: { category: 'recharge', userID: 'u2' },
      });
    });

    it('records a before/after audit row in the same transaction', async () => {
      activeUsers(['u1']);
      const before = [
        { category: 'recharge', userID: 'old', sortOrder: 0, enabled: true },
      ];
      beforeRows = before;

      await replace([{ category: 'recharge', userID: 'u1', sortOrder: 0 }]);

      expect(audit.recordInTransaction).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          actorId: 'admin-1',
          actorAccountId: 'admin-account',
          action: 'support.agents.replace',
          targetType: 'support_agents',
          before,
          after: [
            { category: 'recharge', userID: 'u1', sortOrder: 0, enabled: true },
          ],
        }),
      );
    });

    // 没有这把锁,两个管理员同时提交会各自读到同一份 before 快照、各自只删自己
    // 快照里的行,最终落库的是两份 payload 的并集 —— 谁都没提交过那个组合。
    it('serializes the whole-table replacement behind an advisory lock taken before the read', async () => {
      activeUsers(['u1']);

      await replace([{ category: 'recharge', userID: 'u1', sortOrder: 0 }]);

      expect(tx.$executeRaw).toHaveBeenCalled();
      const lockSql = JSON.stringify(tx.$executeRaw.mock.calls[0][0]);
      expect(lockSql).toMatch(/pg_advisory_xact_lock/);
      expect(lockSql).toMatch(/support-agents-replace/);

      // 锁必须先于 before 快照,否则两个事务照样能读到同一份旧值。
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.supportAgent.findMany.mock.invocationCallOrder[0],
      );
    });

    // advisory lock 只保证两个写入不交错,拦不住「后到的整表覆盖把先到的改动整个
    // 抹掉」。管理台 refetchOnWindowFocus=false,旧页签会一直停在旧数据上。
    it('rejects a save built on a stale snapshot instead of overwriting', async () => {
      activeUsers(['u1']);
      beforeRows = [
        {
          category: 'recharge',
          userID: 'other-admin',
          sortOrder: 0,
          enabled: true,
        },
      ];

      await expect(
        service.replaceAgents(
          operator,
          [{ category: 'recharge', userID: 'u1', sortOrder: 0 }],
          // 页面加载时表还是空的 —— 之后另一个管理员存了 other-admin。
          supportAgentsRevision([]),
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      // 冲突时一行都不能动。
      expect(tx.supportAgent.deleteMany).not.toHaveBeenCalled();
      expect(tx.supportAgent.createMany).not.toHaveBeenCalled();
      expect(tx.supportAgent.update).not.toHaveBeenCalled();
      expect(audit.recordInTransaction).not.toHaveBeenCalled();
    });

    it('accepts a save whose snapshot still matches', async () => {
      activeUsers(['u1']);
      beforeRows = [
        { category: 'recharge', userID: 'u1', sortOrder: 0, enabled: true },
      ];

      await expect(
        replace([{ category: 'recharge', userID: 'u1', sortOrder: 1 }]),
      ).resolves.toBeDefined();
      expect(tx.supportAgent.update).toHaveBeenCalled();
    });

    // 过渡期兼容:后端与管理台分开部署,一上来就必填会让「新后端 + 旧管理台」
    // 窗口里的每次保存都 400。缺省时退回旧行为,不做并发校验。
    it('still applies a write that omits the revision (rolling-deploy window)', async () => {
      activeUsers(['u1']);
      beforeRows = [
        { category: 'recharge', userID: 'other', sortOrder: 0, enabled: true },
      ];

      await service.replaceAgents(
        operator,
        [{ category: 'recharge', userID: 'u1', sortOrder: 0 }],
        undefined,
      );

      expect(tx.supportAgent.createMany).toHaveBeenCalled();
    });

    // 两个管理员各自把表改成同样的结果 —— 后提交的那个是空操作,不该报冲突。
    // 内容哈希的意义就在这里;报 409 会和上面 revisionOf 的文档自相矛盾。
    it('accepts a stale save whose payload already equals the current state', async () => {
      activeUsers(['u1']);
      const target = {
        category: 'recharge' as const,
        userID: 'u1',
        sortOrder: 0,
      };
      // 库里已经是目标状态了(别人先存的),而本次带的是更早的 revision。
      beforeRows = [{ ...target, enabled: true }];

      await expect(
        service.replaceAgents(operator, [target], supportAgentsRevision([])),
      ).resolves.toBeDefined();
    });

    it('clears the table when given an empty payload', async () => {
      beforeRows = [
        { category: 'recharge', userID: 'u1', sortOrder: 0, enabled: true },
      ];

      await replace([]);

      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(tx.supportAgent.deleteMany).toHaveBeenCalledWith({
        where: { OR: [{ category: 'recharge', userID: 'u1' }] },
      });
      expect(tx.supportAgent.createMany).not.toHaveBeenCalled();
      expect(tx.supportAgent.update).not.toHaveBeenCalled();
    });

    // Prisma 交互式事务默认 5s。满额 payload 的整体重排在生产的坏时段里根本跑不完,
    // 于是一个完全合法的请求被整个回滚 —— 且回滚的是「已经删了旧行」的中途状态。
    describe('at the maximum payload size', () => {
      const ROUND_TRIP_MS = 50; // 坏时段的单次往返预算,和 service 里的推算同源
      const PRISMA_DEFAULT_TIMEOUT_MS = 5_000;

      // 记账用的假事务:每次落到数据库的调用推进一次虚拟时钟,末了按事务实际
      // 拿到的 timeout 判定这次替换是被提交了还是被超时回滚了。
      const runWithSimulatedLatency = async (
        input: Parameters<typeof service.replaceAgents>[1],
      ) => {
        let elapsed = 0;
        const tick =
          <T>(result: T) =>
          () => {
            elapsed += ROUND_TRIP_MS;
            return Promise.resolve(result);
          };
        tx.$executeRaw.mockImplementation(tick(0));
        tx.supportAgent.findMany.mockImplementation(tick(beforeRows));
        tx.supportAgent.deleteMany.mockImplementation(tick({ count: 0 }));
        tx.supportAgent.createMany.mockImplementation(tick({ count: 0 }));
        tx.supportAgent.update.mockImplementation(tick({}));
        audit.recordInTransaction.mockImplementation(tick({}));

        let timeout = PRISMA_DEFAULT_TIMEOUT_MS;
        prisma.$transaction.mockImplementation((callback, options) => {
          timeout = options?.timeout ?? PRISMA_DEFAULT_TIMEOUT_MS;
          return callback(tx);
        });

        await service.replaceAgents(operator, input, undefined);
        return { elapsed, timeout };
      };

      const fullPayload = Array.from(
        { length: SUPPORT_AGENTS_MAX },
        (_, i) => ({
          category: 'recharge' as const,
          userID: `u${i}`,
          sortOrder: i,
        }),
      );

      beforeEach(() => {
        activeUsers(fullPayload.map((agent) => agent.userID));
      });

      // jest.clearAllMocks() 只清调用记录、不还原 implementation,不还原就会把
      // 这个假事务泄漏给后面的用例。
      afterEach(() => {
        prisma.$transaction.mockImplementation(runTransaction);
      });

      it('finishes inside the configured transaction timeout', async () => {
        // 全是新行:一次 createMany 就够,逐行 update 一条都不发。
        const { elapsed, timeout } = await runWithSimulatedLatency(fullPayload);

        expect(tx.supportAgent.createMany).toHaveBeenCalledTimes(1);
        expect(tx.supportAgent.update).not.toHaveBeenCalled();
        expect(timeout).toBe(REPLACE_TRANSACTION_TIMEOUT_MS);
        expect(elapsed).toBeLessThan(timeout);
      });

      // 最坏情况:满额的表被整体重排,每一行都得单独 update。
      it('still finishes when every row changed, which the 5s default would not', async () => {
        beforeRows = fullPayload.map((agent) => ({
          ...agent,
          sortOrder: agent.sortOrder + 1,
          enabled: true,
        }));

        const { elapsed, timeout } = await runWithSimulatedLatency(fullPayload);

        expect(tx.supportAgent.update).toHaveBeenCalledTimes(
          SUPPORT_AGENTS_MAX,
        );
        expect(elapsed).toBeLessThan(timeout);
        // 这一行是这个用例的意义所在:没有显式 timeout 就会在这里超时回滚。
        expect(elapsed).toBeGreaterThan(PRISMA_DEFAULT_TIMEOUT_MS);
      });
    });
  });

  describe('listAuditLogs', () => {
    // 审计只写不可读是这条读路径存在的全部理由:哨兵目标过不了
    // /admin/users/:id/audit-logs 的 ParseUUIDPipe。
    it('reads back the sentinel target the replacement writes to', async () => {
      audit.listForTarget.mockResolvedValue([{ id: 'audit-1' }]);

      await expect(service.listAuditLogs(50)).resolves.toEqual([
        { id: 'audit-1' },
      ]);
      expect(audit.listForTarget).toHaveBeenCalledWith(
        'support_agents',
        SUPPORT_AGENTS_AUDIT_TARGET_ID,
        50,
      );
    });

    it('defaults to a bounded page', async () => {
      audit.listForTarget.mockResolvedValue([]);

      await service.listAuditLogs();

      expect(audit.listForTarget).toHaveBeenCalledWith(
        'support_agents',
        SUPPORT_AGENTS_AUDIT_TARGET_ID,
        20,
      );
    });
  });

  describe('supportAgentsRevision', () => {
    const rows = [
      { category: 'recharge', userID: 'a', sortOrder: 0, enabled: true },
      { category: 'issue', userID: 'b', sortOrder: 1, enabled: false },
    ];

    // 数据库返回顺序抖动不该被当成「别人改过了」。
    it('does not depend on row order', () => {
      expect(supportAgentsRevision(rows)).toBe(
        supportAgentsRevision([...rows].reverse()),
      );
    });

    it.each([
      ['sortOrder', { ...rows[0], sortOrder: 9 }],
      ['enabled', { ...rows[0], enabled: false }],
      ['userID', { ...rows[0], userID: 'z' }],
      ['category', { ...rows[0], category: 'dispute' }],
    ])('changes when %s changes', (_what, changed) => {
      expect(supportAgentsRevision([changed, rows[1]])).not.toBe(
        supportAgentsRevision(rows),
      );
    });

    it('changes when a row is added or removed', () => {
      expect(supportAgentsRevision([rows[0]])).not.toBe(
        supportAgentsRevision(rows),
      );
      expect(supportAgentsRevision([])).not.toBe(supportAgentsRevision(rows));
    });
  });

  describe('isSupportAgent', () => {
    it('only counts enabled rows', async () => {
      prisma.supportAgent.findFirst.mockResolvedValue({ id: 'row-1' });

      await expect(service.isSupportAgent('u1')).resolves.toBe(true);
      expect(prisma.supportAgent.findFirst.mock.calls[0][0].where).toEqual({
        userID: 'u1',
        enabled: true,
      });
    });

    it('is false for a user that is not a support agent', async () => {
      prisma.supportAgent.findFirst.mockResolvedValue(null);

      await expect(service.isSupportAgent('u1')).resolves.toBe(false);
    });
  });
});
