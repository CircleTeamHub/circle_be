import { createDependencyMetrics } from './dependency-metrics';

describe('createDependencyMetrics', () => {
  it('exports the known LiveKit operations at zero before the first call', async () => {
    // 从 0 开始导出：increase() 才能把进程启动后的第一批失败算进失败率。
    const output = await createDependencyMetrics().registry.metrics();

    for (const operation of ['create_room', 'delete_room']) {
      for (const result of ['success', 'not_found', 'failure']) {
        expect(output).toMatch(
          new RegExp(
            `circle_dependency_requests_total\\{dependency="livekit",operation="${operation}",result="${result}"\\} 0`,
          ),
        );
      }
    }
  });

  it('counts requests per dependency, operation and result', async () => {
    const metrics = createDependencyMetrics();

    metrics.record('object_storage', 'PutObject', 'failure');
    metrics.record('object_storage', 'PutObject', 'failure');
    metrics.record('object_storage', 'HeadObject', 'not_found');
    metrics.record('livekit', 'create_room', 'success');

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /circle_dependency_requests_total\{dependency="object_storage",operation="PutObject",result="failure"\} 2/,
    );
    expect(output).toMatch(
      /circle_dependency_requests_total\{dependency="object_storage",operation="HeadObject",result="not_found"\} 1/,
    );
    expect(output).toMatch(
      /circle_dependency_requests_total\{dependency="livekit",operation="create_room",result="success"\} 1/,
    );
  });

  it('folds an unexpected operation name into a bounded label value', async () => {
    const metrics = createDependencyMetrics();

    metrics.record('object_storage', 'Weird Name/with\nstuff', 'success');

    const output = await metrics.registry.metrics();
    expect(output).toMatch(/operation="other",result="success"\} 1/);
  });
});
