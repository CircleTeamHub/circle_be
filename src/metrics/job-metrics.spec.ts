import { createJobMetrics, OTHER_JOB } from './job-metrics';

describe('createJobMetrics', () => {
  it('counts runs by job and result', async () => {
    const metrics = createJobMetrics();

    metrics.recordRun('notification_push_outbox', 'success', 0.2);
    metrics.recordRun('notification_push_outbox', 'success', 0.3);
    metrics.recordRun('notification_push_outbox', 'failure', 0.1);

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_cron_runs_total\{[^}]*job="notification_push_outbox"[^}]*result="success"[^}]*\}\s+2/,
    );
    expect(text).toMatch(
      /circle_cron_runs_total\{[^}]*result="failure"[^}]*\}\s+1/,
    );
  });

  it('advances the success heartbeat only on success', async () => {
    const metrics = createJobMetrics();

    metrics.recordRun('chat_burn_sweeper', 'success', 0.1, 1_000_000);
    metrics.recordRun('chat_burn_sweeper', 'failure', 0.1, 2_000_000);

    const text = await metrics.registry.metrics();
    // 秒（不是毫秒）—— 告警写的是 time() - metric，两边必须同一单位。
    expect(text).toMatch(
      /circle_cron_last_success_timestamp_seconds\{job="chat_burn_sweeper"\}\s+1000\b/,
    );
  });

  it('seeds the heartbeat at registration so a job that never runs still alerts', async () => {
    // 心跳告警是 `time() - metric > 阈值`。首次成功前若序列不存在，表达式
    // 求值为空 —— 一个从开机起就没跑过的任务反而永远不告警（和 alerts.yml
    // 里 `up` 消失、`up == 0` 打不中是同一个坑）。注册时就播种，让计时从
    // 进程启动开始。
    const metrics = createJobMetrics();

    metrics.registerJob('refresh_token_cleanup', { nowMs: 1_500_000 });

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_cron_last_success_timestamp_seconds\{job="refresh_token_cleanup"\}\s+1500\b/,
    );
    // 播种不能伪造「跑过一次」：runs_total 必须还是干净的 0 起点。
    expect(text).not.toMatch(
      /circle_cron_runs_total\{[^}]*job="refresh_token_cleanup"/,
    );
  });

  it('never rewinds the heartbeat when a stale run reports late', async () => {
    const metrics = createJobMetrics();

    metrics.recordRun('call_cleanup', 'success', 0.1, 5_000_000);
    metrics.recordRun('call_cleanup', 'success', 0.1, 3_000_000);

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_cron_last_success_timestamp_seconds\{job="call_cleanup"\}\s+5000\b/,
    );
  });

  it('records outbox depth, oldest age and dead-letter counts by queue', async () => {
    const metrics = createJobMetrics();

    metrics.setOutboxDepth({
      queue: 'notification_push',
      pending: 42,
      oldestAgeSeconds: 900,
      dead: 3,
    });

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_outbox_pending\{queue="notification_push"\}\s+42/,
    );
    expect(text).toMatch(
      /circle_outbox_oldest_age_seconds\{queue="notification_push"\}\s+900/,
    );
    expect(text).toMatch(/circle_outbox_dead\{queue="notification_push"\}\s+3/);
  });

  it('reports an empty queue as zero rather than dropping the series', async () => {
    // 队列排空后必须显式写 0。留着上一次的非零值会让积压告警永远 firing;
    // 直接不写这个 label 又会让序列消失,`> 阈值` 打不中,和心跳同一个坑。
    const metrics = createJobMetrics();

    metrics.setOutboxDepth({
      queue: 'session_revocation',
      pending: 7,
      oldestAgeSeconds: 60,
      dead: 0,
    });
    metrics.setOutboxDepth({
      queue: 'session_revocation',
      pending: 0,
      oldestAgeSeconds: 0,
      dead: 0,
    });

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_outbox_pending\{queue="session_revocation"\}\s+0/,
    );
    expect(text).toMatch(
      /circle_outbox_oldest_age_seconds\{queue="session_revocation"\}\s+0/,
    );
  });

  it('bounds job-name cardinality so a misused label cannot explode series', async () => {
    const metrics = createJobMetrics();

    for (let i = 0; i < 500; i += 1) {
      metrics.recordRun(`accidental_id_${i}`, 'success', 0.1);
    }

    const text = await metrics.registry.metrics();
    const jobs = new Set(
      [...text.matchAll(/circle_cron_runs_total\{[^}]*job="([^"]+)"/g)].map(
        (match) => match[1],
      ),
    );
    expect(jobs.size).toBeLessThanOrEqual(101);
    expect(jobs.has(OTHER_JOB)).toBe(true);
  });

  it('isolates registries per instance', async () => {
    const a = createJobMetrics();
    const b = createJobMetrics();

    a.recordRun('temp_chat_cleanup', 'success', 0.1);

    const textB = await b.registry.metrics();
    expect(textB).not.toMatch(/job="temp_chat_cleanup"/);
  });
});

describe('createJobMetrics — review #150 follow-ups', () => {
  it('exposes the last run result so cadence-independent alerting works', async () => {
    // rate(...[15m]) 对每天/每小时的任务不可靠：单次失败的增量在 for: 15m
    // 满足之前就滑出窗口，storage_audit / refresh_token_cleanup 这类任务
    // 可以每次都失败而告警始终静默。last_result 与执行频率无关。
    const metrics = createJobMetrics();

    metrics.registerJob('storage_audit', { nowMs: 1_000_000 });
    let text = await metrics.registry.metrics();
    // 播种为成功：任务从没跑过属于「停摆」，由 CronJobStalled 负责，
    // 不该让 last_result 一开机就报红。
    expect(text).toMatch(/circle_cron_last_result\{job="storage_audit"\}\s+1/);

    metrics.recordRun('storage_audit', 'failure', 1, 2_000_000);
    text = await metrics.registry.metrics();
    expect(text).toMatch(/circle_cron_last_result\{job="storage_audit"\}\s+0/);

    metrics.recordRun('storage_audit', 'success', 1, 3_000_000);
    text = await metrics.registry.metrics();
    expect(text).toMatch(/circle_cron_last_result\{job="storage_audit"\}\s+1/);
  });

  it('tracks per-queue probe freshness so a silently failing probe is visible', async () => {
    // collectOutboxDepths 刻意让单个队列失败不影响其它队列，代价是失败的队列
    // 会保留上一次读数不动，而 refresh() 仍然成功 —— 队列积压时 gauge 可能
    // 停在 0 上一直是绿的。新鲜度是那种情况下唯一的信号。
    const metrics = createJobMetrics();

    metrics.registerOutboxQueue('session_revocation', 1_000_000);
    let text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_outbox_last_probe_timestamp_seconds\{queue="session_revocation"\}\s+1000\b/,
    );

    metrics.setOutboxDepth(
      {
        queue: 'session_revocation',
        pending: 3,
        oldestAgeSeconds: 30,
        dead: 0,
      },
      2_000_000,
    );
    text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_outbox_last_probe_timestamp_seconds\{queue="session_revocation"\}\s+2000\b/,
    );
  });

  it('leaves a failing queue stale while its healthy neighbours stay fresh', async () => {
    const metrics = createJobMetrics();
    metrics.registerOutboxQueue('gift_card', 1_000_000);
    metrics.registerOutboxQueue('notification_push', 1_000_000);

    // 只有 notification_push 探测成功
    metrics.setOutboxDepth(
      { queue: 'notification_push', pending: 0, oldestAgeSeconds: 0, dead: 0 },
      9_000_000,
    );

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_outbox_last_probe_timestamp_seconds\{queue="notification_push"\}\s+9000\b/,
    );
    expect(text).toMatch(
      /circle_outbox_last_probe_timestamp_seconds\{queue="gift_card"\}\s+1000\b/,
    );
  });
});
