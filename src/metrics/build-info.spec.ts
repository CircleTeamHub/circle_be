import {
  commitLabel,
  createBuildInfoMetrics,
  UNKNOWN_BUILD_VALUE,
  versionLabel,
} from './build-info';

describe('build info metric', () => {
  it('exports the release version and short commit as labels', async () => {
    const metrics = createBuildInfoMetrics({
      release: 'circle-be@v1.4.2',
      commit: '8C8EE01A2B3C4D5E6F708192A3B4C5D6E7F80912',
    });

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /circle_build_info\{version="v1\.4\.2",commit="8c8ee01a2b3c"\} 1/,
    );
  });

  it('still exports a series when neither value is known', async () => {
    // 没有序列的话，大盘的发版标记和 BackendVersionSkew 都会把这台实例当成不存在。
    const metrics = createBuildInfoMetrics({});

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /circle_build_info\{version="unknown",commit="unknown"\} 1/,
    );
  });

  it.each([
    ['circle-be@v2.0.0', 'v2.0.0'],
    ['  circle-be@v2.0.0-rc.1  ', 'v2.0.0-rc.1'],
    ['1.0.0', '1.0.0'],
    ['', UNKNOWN_BUILD_VALUE],
    ['circle-be@', UNKNOWN_BUILD_VALUE],
    ['circle-be@v1 with spaces', UNKNOWN_BUILD_VALUE],
    ['circle-be@"injected"', UNKNOWN_BUILD_VALUE],
    [`circle-be@v${'1'.repeat(80)}`, UNKNOWN_BUILD_VALUE],
    [undefined, UNKNOWN_BUILD_VALUE],
    [42, UNKNOWN_BUILD_VALUE],
  ])('versionLabel(%p) → %p', (input, expected) => {
    expect(versionLabel(input)).toBe(expected);
  });

  it.each([
    ['abcdef1', 'abcdef1'],
    ['ABCDEF1234567890', 'abcdef123456'],
    ['not-a-sha', UNKNOWN_BUILD_VALUE],
    ['abc', UNKNOWN_BUILD_VALUE],
    ['unknown', UNKNOWN_BUILD_VALUE],
    [undefined, UNKNOWN_BUILD_VALUE],
  ])('commitLabel(%p) → %p', (input, expected) => {
    expect(commitLabel(input)).toBe(expected);
  });
});
