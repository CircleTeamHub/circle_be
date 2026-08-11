import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  Cron,
  CronExpression,
  ScheduleModule,
  SchedulerRegistry,
} from '@nestjs/schedule';
import { createJobMetrics } from './job-metrics';
import { runTracked, TrackedCron } from './tracked-cron.decorator';
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
