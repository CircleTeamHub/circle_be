import { PrismaService } from 'src/prisma/prisma.service';
import { ConsoleReleasesService } from './console-releases.service';

jest.mock('src/admin-operations/admin-operation-request', () => ({
  runAdminOperation: jest.fn(
    (
      prisma: { tx: unknown },
      _actor: string,
      _operation: string,
      _key: string | undefined,
      _payload: object,
      execute: (tx: unknown) => Promise<unknown>,
    ) => execute(prisma.tx),
  ),
  writeOperationAudit: jest.fn(),
}));

/**
 * GET /app-operations/update(匿名,每次 App 启动都调)按 (platform, channel, build)
 * 缓存计划查询 30 秒;是否命中灰度、是否在时间窗内仍按每个请求的 installation 和
 * 当前时间判断。同进程的发版写入提交后立即清缓存。
 */
describe('update decision cache', () => {
  const t0 = new Date('2026-10-25T00:00:00Z').getTime();
  const release = {
    id: 'release-2',
    platform: 'android',
    channel: 'stable',
    version: '2.0.0',
    build: 200,
    url: 'https://example.com/app.apk',
    sha256: 'a'.repeat(64),
    sizeBytes: 1,
    notes: '',
    withdrawnAt: null,
    createdAt: new Date(t0 - 86400_000),
  };
  const plan = (overrides: Record<string, unknown> = {}) => ({
    id: 'plan-1',
    releaseID: release.id,
    enabled: true,
    rollout: 100,
    forceBelow: 0,
    minBuild: 0,
    maxBuild: 199,
    startsAt: new Date(t0 - 3600_000),
    endsAt: new Date(t0 + 3600_000),
    createdAt: new Date(t0 - 3600_000),
    version: 0,
    release,
    ...overrides,
  });
  const client = {
    platform: 'android',
    channel: 'stable',
    build: 100,
    installation: 'installation-0001',
  };

  function setup(plans = [plan()]) {
    const tx = {
      $queryRaw: jest.fn(),
      consoleRelease: {
        create: jest.fn().mockResolvedValue({ id: 'release-3' }),
        findUnique: jest.fn().mockResolvedValue(release),
        update: jest.fn().mockResolvedValue(release),
      },
      consoleReleasePlan: {
        create: jest.fn().mockResolvedValue({ id: 'plan-2' }),
      },
    };
    const prisma = {
      tx,
      consoleReleasePlan: { findMany: jest.fn().mockResolvedValue(plans) },
      appInstallation: { findUnique: jest.fn() },
    };
    const service = new ConsoleReleasesService(
      prisma as unknown as PrismaService,
    );
    return { prisma, service };
  }

  let now: jest.SpyInstance;
  beforeEach(() => {
    now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    jest.useFakeTimers({ now: t0, doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  const advance = (ms: number) => {
    jest.setSystemTime(Date.now() + ms);
    now.mockReturnValue(t0 + ms);
  };

  it('queries the plans once per platform/channel/build within 30 seconds, deciding per installation', async () => {
    const { prisma, service } = setup();

    const first = await service.decision(client);
    advance(29_999);
    const second = await service.decision({
      ...client,
      installation: 'installation-0002',
    });

    expect(first.update?.versionCode).toBe(200);
    expect(second.update?.versionCode).toBe(200);
    expect(prisma.consoleReleasePlan.findMany).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by build: another build queries again', async () => {
    const { prisma, service } = setup();

    await service.decision(client);
    await service.decision({ ...client, build: 101 });
    await service.decision({ ...client, channel: 'beta' });

    expect(prisma.consoleReleasePlan.findMany).toHaveBeenCalledTimes(3);
  });

  it('queries again after 30 seconds', async () => {
    const { prisma, service } = setup();

    await service.decision(client);
    advance(30_000);
    await service.decision(client);

    expect(prisma.consoleReleasePlan.findMany).toHaveBeenCalledTimes(2);
  });

  it('still applies the time window and rollout to every request from the cached plans', async () => {
    const { service } = setup([plan({ endsAt: new Date(t0 + 10_000) })]);

    expect((await service.decision(client)).update).not.toBeNull();
    advance(10_000);
    expect((await service.decision(client)).update).toBeNull();
  });

  it.each([
    [
      'create',
      (s: ConsoleReleasesService) =>
        s.create(
          'admin',
          {
            platform: 'android',
            channel: 'stable',
            version: '3.0.0',
            build: 3_000_000,
            url: 'https://github.com/CircleTeamHub/windnote-releases/releases/download/v3.0.0/windnote.apk',
            sha256: 'b'.repeat(64),
            sizeBytes: 1,
            notes: '',
            reason: '新版本上线',
          } as never,
          'key',
        ),
    ],
    [
      'withdraw',
      (s: ConsoleReleasesService) =>
        s.withdraw('admin', release.id, { reason: '撤回坏包' }, 'key'),
    ],
    [
      'plan',
      (s: ConsoleReleasesService) =>
        s.plan(
          'admin',
          undefined,
          {
            releaseID: release.id,
            rollout: 50,
            forceBelow: 0,
            minBuild: 0,
            maxBuild: 199,
            enabled: true,
            startsAt: new Date(t0).toISOString(),
            endsAt: new Date(t0 + 86400_000).toISOString(),
            reason: '灰度一半',
          } as never,
          'key',
        ),
    ],
  ])('drops the cache right after %s commits', async (_name, write) => {
    const { prisma, service } = setup();

    await service.decision(client);
    await write(service);
    await service.decision(client);

    expect(prisma.consoleReleasePlan.findMany).toHaveBeenCalledTimes(2);
  });

  it('never serves the admin preview from the cache', async () => {
    const { prisma, service } = setup();

    await service.decision(client);
    await service.preview(client);
    await service.preview(client);

    expect(prisma.consoleReleasePlan.findMany).toHaveBeenCalledTimes(3);
  });
});
