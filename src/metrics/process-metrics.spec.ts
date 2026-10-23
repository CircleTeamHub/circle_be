import { createProcessMetrics } from './process-metrics';

describe('createProcessMetrics', () => {
  it('exports the unhandled rejection counter at zero before anything happens', async () => {
    const metrics = createProcessMetrics();

    // 从 0 开始导出（而不是第一次 rejection 才出现），increase() 才能把
    // 进程启动后的第一条算进去。
    const output = await metrics.registry.metrics();
    expect(output).toMatch(/circle_unhandled_rejections_total\s+0/);
  });

  it('counts each unhandled rejection', async () => {
    const metrics = createProcessMetrics();

    metrics.recordUnhandledRejection();
    metrics.recordUnhandledRejection();

    const output = await metrics.registry.metrics();
    expect(output).toMatch(/circle_unhandled_rejections_total\s+2/);
  });
});
