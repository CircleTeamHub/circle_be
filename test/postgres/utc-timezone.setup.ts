/**
 * 真库回归一律按 UTC 跑:node-pg 按进程本地时区序列化 Date,而表里多是不带时区的
 * timestamp(`::timestamp` 会丢掉偏移)。CI 是 UTC,开发机在 Asia/Shanghai 或
 * America/Los_Angeles 时同一份测试会差几个小时、假红。生产路径(adapter-pg 发 UTC
 * 字符串)不受影响,这里只对齐测试进程。
 *
 * 必须是 globalSetup:setupFiles 里拿到的 process.env 是 jest 给沙箱的拷贝,改它
 * 碰不到真正的进程环境;配置里 maxWorkers=1,测试和这里在同一个进程。
 */
export default function setUtcTimezone(): void {
  process.env.TZ = 'UTC';
}
