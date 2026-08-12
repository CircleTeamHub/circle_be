import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  Cron,
  CronExpression,
  ScheduleModule,
  SchedulerRegistry,
} from '@nestjs/schedule';
import { createJobMetrics } from './job-metrics';
import {
  reportHandledJobFailure,
  reportJobSkipped,
  runTracked,
  TrackedCron,
} from './tracked-cron.decorator';
import { jobMetrics } from './job-metrics';

describe('runTracked', () => {
  it('returns the wrapped result untouched', async () => {
    const metrics = createJobMetrics();

    const result = await runTracked(metrics, 'demo', () => 42);

    expect(result).toBe(42);
  });

  it('records a success with its duration', async () => {
    const metrics = createJobMetrics();
    const elapsed = jest
      .fn<number, []>()
      .mockReturnValueOnce(5_000)
      .mockReturnValueOnce(7_500);

    await runTracked(metrics, 'demo', async () => 'ok', {
      elapsedMs: elapsed,
      nowMs: () => 1_002_500,
    });

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_cron_runs_total\{[^}]*job="demo"[^}]*result="success"[^}]*\}\s+1/,
    );
    expect(text).toMatch(
      /circle_cron_last_duration_seconds\{job="demo"\}\s+2\.5/,
    );
    expect(text).toMatch(
      /circle_cron_last_success_timestamp_seconds\{job="demo"\}\s+1002\.5/,
    );
  });

  it('records a failure and rethrows the original error unchanged', async () => {
    const metrics = createJobMetrics();
    const boom = new Error('boom');

    await expect(
      runTracked(metrics, 'demo', () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_cron_runs_total\{[^}]*job="demo"[^}]*result="failure"[^}]*\}\s+1/,
    );
  });

  it('leaves the heartbeat at its seeded value when every run fails', async () => {
    // 这是这套指标存在的理由：任务在跑、在报错，但「上次成功」不前进,
    // 心跳告警照样会响 —— 而 outbox 那类自己吞异常的处理器连 failure
    // 都不会有,只能靠积压指标发现。
    const metrics = createJobMetrics();
    metrics.registerJob('demo', { nowMs: 1_000_000 });

    await expect(
      runTracked(metrics, 'demo', () => Promise.reject(new Error('x')), {
        elapsedMs: () => 0,
        nowMs: () => 9_000_000,
      }),
    ).rejects.toThrow('x');

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_cron_last_success_timestamp_seconds\{job="demo"\}\s+1000\b/,
    );
  });

  it('does not read the wall clock before the job runs', async () => {
    // 回归钉子：包装器若在调用原函数前读一次 Date.now()，就会打乱被包装方法
    // 自己的时钟序列。notification-retention 的扫表预算是
    // `Date.now() - startedAt >= 预算`，其单测用 mockReturnValueOnce(0) 钉住
    // 第一次读数 —— 多插一次读取，预算永远判不到，扫表死循环直到测试超时。
    // 耗时改用单调时钟后，墙钟只在任务返回后读。
    const metrics = createJobMetrics();
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(0).mockReturnValue(15_000);

    const observed: number[] = [];
    await runTracked(metrics, 'demo', () => {
      observed.push(Date.now());
    });

    // 被包装的任务必须拿到那个 mockReturnValueOnce(0)。
    expect(observed).toEqual([0]);
    nowSpy.mockRestore();
  });
});

describe('TrackedCron', () => {
  it('registers the same scheduler metadata as a plain @Cron', () => {
    class Plain {
      @Cron(CronExpression.EVERY_MINUTE)
      run(): void {}
    }
    class Tracked {
      @TrackedCron(CronExpression.EVERY_MINUTE, 'tracked_metadata_probe')
      run(): void {}
    }

    const plainKeys = Reflect.getMetadataKeys(Plain.prototype.run).sort();
    const trackedKeys = Reflect.getMetadataKeys(Tracked.prototype.run).sort();

    expect(trackedKeys).toEqual(plainKeys);
    expect(trackedKeys.length).toBeGreaterThan(0);
    for (const key of plainKeys) {
      expect(Reflect.getMetadata(key, Tracked.prototype.run)).toEqual(
        Reflect.getMetadata(key, Plain.prototype.run),
      );
    }
  });

  it('seeds the heartbeat at decoration time, before the job ever runs', async () => {
    class Probe {
      @TrackedCron(CronExpression.EVERY_MINUTE, 'tracked_seed_probe')
      run(): void {}
    }
    expect(Probe).toBeDefined();

    const text = await jobMetrics.registry.metrics();
    expect(text).toMatch(
      /circle_cron_last_success_timestamp_seconds\{job="tracked_seed_probe"\}/,
    );
  });

  it('preserves `this`, arguments and the return value', async () => {
    class Probe {
      multiplier = 3;

      @TrackedCron(CronExpression.EVERY_MINUTE, 'tracked_passthrough_probe')
      async run(value: number): Promise<number> {
        return value * this.multiplier;
      }
    }

    await expect(new Probe().run(5)).resolves.toBe(15);
  });
});

describe('TrackedCron runtime registration', () => {
  // 18 个生产定时任务全部换成了这个装饰器。元数据等价是间接证据;这里让真正的
  // ScheduleModule explorer 跑一遍,直接证明任务确实被注册进调度器,而且注册的
  // 是**记账过的包装函数**而不是原函数 —— 后者会让所有心跳永远不前进,
  // CronJobStalled 全体误报。
  it('registers with the real scheduler and schedules the wrapped function', async () => {
    @Injectable()
    class Probe {
      ran = 0;

      @TrackedCron(CronExpression.EVERY_MINUTE, 'runtime_probe', {
        name: 'runtime-probe',
      })
      async run(): Promise<void> {
        this.ran += 1;
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [Probe],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      const registry = app.get(SchedulerRegistry);
      const job = registry.getCronJob('runtime-probe');
      expect(job).toBeDefined();

      const before = await jobMetrics.registry.metrics();
      expect(before).not.toMatch(/job="runtime_probe"[^}]*result="success"/);

      // 直接触发调度器持有的那个回调,而不是我们手里的实例方法。
      await job.fireOnTick();

      const probe = app.get(Probe);
      expect(probe.ran).toBe(1);
      const after = await jobMetrics.registry.metrics();
      expect(after).toMatch(
        /circle_cron_runs_total\{[^}]*job="runtime_probe"[^}]*result="success"[^}]*\}\s+1/,
      );
    } finally {
      await app.close();
    }
  });
});

describe('reportHandledJobFailure', () => {
  it('turns a swallowed failure into a recorded failure', async () => {
    // 多数定时任务把整轮工作包在 try/catch 里、失败后正常返回（chat-circle-sync
    // 扫描失败即 return，各 cleanup 记日志后继续）。包装器只看「有没有抛」的话，
    // 持续故障期间它们每轮都算成功、心跳照常前进 —— CronJobFailing 和
    // CronJobStalled 双双打不中，而实际上一点活都没干。
    const metrics = createJobMetrics();

    await runTracked(metrics, 'swallower', () => {
      try {
        throw new Error('db down');
      } catch {
        reportHandledJobFailure();
      }
    });

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_cron_runs_total\{[^}]*job="swallower"[^}]*result="failure"[^}]*\}\s+1/,
    );
    expect(text).toMatch(/circle_cron_last_result\{job="swallower"\}\s+0/);
  });

  it('does not advance the heartbeat for a handled failure', async () => {
    const metrics = createJobMetrics();
    metrics.registerJob('swallower', { nowMs: 1_000_000 });

    await runTracked(
      metrics,
      'swallower',
      () => {
        reportHandledJobFailure();
      },
      { elapsedMs: () => 0, nowMs: () => 9_000_000 },
    );

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_cron_last_success_timestamp_seconds\{job="swallower"\}\s+1000\b/,
    );
  });

  it('still returns the job’s value', async () => {
    const metrics = createJobMetrics();
    const result = await runTracked(metrics, 'swallower', () => {
      reportHandledJobFailure();
      return 7;
    });
    expect(result).toBe(7);
  });

  it('survives being called outside any tracked job', () => {
    // 这些方法也会被别处直接调用（测试、管理台手动触发）。脱离 cron 上下文
    // 时必须是无操作，绝不能抛 —— 观测代码不该改变业务行为。
    expect(() => reportHandledJobFailure()).not.toThrow();
  });

  it('attributes the failure to the job that is actually running', async () => {
    // 并发任务共用一个模块级 storage，串台会把失败记到无辜的任务头上。
    const metrics = createJobMetrics();
    await Promise.all([
      runTracked(metrics, 'job_a', async () => {
        await new Promise((r) => setTimeout(r, 5));
        reportHandledJobFailure();
      }),
      runTracked(metrics, 'job_b', async () => {
        await new Promise((r) => setTimeout(r, 1));
      }),
    ]);

    const text = await metrics.registry.metrics();
    expect(text).toMatch(/circle_cron_last_result\{job="job_a"\}\s+0/);
    expect(text).toMatch(/circle_cron_last_result\{job="job_b"\}\s+1/);
  });
});

describe('reportJobSkipped', () => {
  it('does not refresh the heartbeat of a job that is still stuck', async () => {
    // review #150：几个 sweeper 有重入闸（`if (this.running) return`）。跳过和
    // 干完了长得一模一样——都是正常返回——所以一次吊死的执行会被后面每一分钟
    // 的跳过持续刷新心跳：CronJobStalled 因为心跳新鲜打不中，CronJobFailing
    // 因为没有失败也打不中，任务实际上已经永久停摆。
    const metrics = createJobMetrics();
    metrics.registerJob('stuck_sweeper', { nowMs: 1_000_000 });

    // 第一轮吊住不返回，随后的 3 次调度全部撞上重入闸。
    let running = false;
    let release = () => {};
    const stuck = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sweep = () =>
      runTracked(
        metrics,
        'stuck_sweeper',
        async () => {
          if (running) {
            reportJobSkipped();
            return;
          }
          running = true;
          await stuck;
        },
        { elapsedMs: () => 0, nowMs: () => 9_000_000 },
      );

    const hung = sweep();
    for (let tick = 0; tick < 3; tick += 1) await sweep();

    const text = await metrics.registry.metrics();
    // 心跳停在播种值 1000s 上，没有被跳过刷新 —— 卡到 3 × 周期之后
    // CronJobStalled 就能报出来。
    expect(text).toMatch(
      /circle_cron_last_success_timestamp_seconds\{job="stuck_sweeper"\}\s+1000\b/,
    );
    expect(text).toMatch(
      /circle_cron_runs_total\{[^}]*job="stuck_sweeper"[^}]*result="skipped"[^}]*\}\s+3/,
    );
    expect(text).not.toMatch(
      /circle_cron_runs_total\{[^}]*job="stuck_sweeper"[^}]*result="success"/,
    );

    release();
    await hung;
  });

  it('does not report a skip as a failure', async () => {
    // 一次**正常**的长执行（大批量到期）也会让下一轮跳过。那不该叫醒任何人：
    // 记成 failure 的话 CronJobFailing 会在完全健康的高负载期间误报。
    const metrics = createJobMetrics();
    // TrackedCron 在装饰期就 registerJob，last_result 因此被播种成 1。
    metrics.registerJob('busy_sweeper');

    await runTracked(metrics, 'busy_sweeper', () => {
      reportJobSkipped();
    });

    const text = await metrics.registry.metrics();
    expect(text).toMatch(/circle_cron_last_result\{job="busy_sweeper"\}\s+1/);
    expect(text).not.toMatch(
      /circle_cron_runs_total\{[^}]*job="busy_sweeper"[^}]*result="failure"/,
    );
  });

  it('keeps the duration of the last real run instead of the skip’s ~0s', async () => {
    // 跳过瞬间返回。让它覆盖 last_duration 的话，大盘会恰好在任务卡住时
    // 显示「耗时 0 秒」。
    const metrics = createJobMetrics();
    const elapsed = jest
      .fn<number, []>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(7_000)
      .mockReturnValue(0);
    const clock = { elapsedMs: elapsed, nowMs: () => 5_000 };

    await runTracked(metrics, 'timed_sweeper', () => undefined, clock);
    await runTracked(metrics, 'timed_sweeper', () => reportJobSkipped(), clock);

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_cron_last_duration_seconds\{job="timed_sweeper"\}\s+7\b/,
    );
  });

  it('loses to a failure reported in the same run', async () => {
    // 重入闸之外还有别的 catch 时，一轮里可能两种都报。按更严重的算。
    const metrics = createJobMetrics();

    await runTracked(metrics, 'both_sweeper', () => {
      reportJobSkipped();
      reportHandledJobFailure();
    });

    const text = await metrics.registry.metrics();
    expect(text).toMatch(/circle_cron_last_result\{job="both_sweeper"\}\s+0/);
    expect(text).toMatch(
      /circle_cron_runs_total\{[^}]*job="both_sweeper"[^}]*result="failure"[^}]*\}\s+1/,
    );
  });

  it('survives being called outside any tracked job', () => {
    expect(() => reportJobSkipped()).not.toThrow();
  });
});
