# 压测与性能剖析脚本

上线前压测用的一套脚本：造数、发压、取证。都是手动工具，不进生产镜像，也不在 CI 里跑。

## 安全约定

- **只对压测库或测试服用**。造数脚本默认只连 `localhost` 上名为 `circle_perf` 的库；连别的库必须显式写出库名（`PERF_REMOTE_DATABASE`），对不上就拒绝。
- **造的数据都能删干净**。每个造数脚本都有 `--clean`，按 `load → media → data` 的顺序删（后两个依赖前面建的用户）。
- **令牌不落进仓库**。`seed-perf-load.cjs` 把令牌写到标准输出，由调用方重定向到仓库外的本地文件；签名密钥只在后端的环境文件里读。
- **结果和样例素材不入库**。结果默认写到系统临时目录下的 `circle-perf-results/`（可用 `PERF_OUT` 改），造数用的样例图片视频由 `--media-dir` 指向仓库外的目录。

## 脚本

| 脚本 | 用途 |
| --- | --- |
| `seed-perf-data.cjs` | 给一个目标账号灌 600 个压测用户、500 个会话、10 万条消息、500 条笔记（前端大数据量测试用） |
| `seed-perf-media.cjs` | 再加带图片视频的会话和笔记，需要 `--media-dir` |
| `seed-perf-load.cjs` | 建只含压测用户的会话，并给每个压测用户签一个访问令牌（后端压测用） |
| `load-chat.cjs` | 发压端：N 个长连接按固定间隔发消息，统计确认、投递、拉列表的延迟 |
| `run-load-steps.sh` | 对测试服阶梯加压，每档中段取一次容器资源和 Prometheus 指标 |
| `bench-local-ab.sh` | 本机对比两个构建：同样负载下每条消息的后端 CPU |
| `bench-local-replicas.sh` | 本机起 N 个实例压多实例 |
| `pg-log-per-message.cjs` | 把 Postgres 语句日志按「每条消息」拆开，数往返次数和库内耗时 |
| `cpu-profile-in-container.cjs` | 在后端容器里采一段主线程 CPU 剖析 |
| `cpuprofile-summary.cjs` | 按代码归属汇总 `.cpuprofile` |
| `perf-android-scroll.sh` | 安卓真机列表滚动的帧耗时和内存 |
| `heapprofd.cfg`、`heap-by-owner.sql` | 安卓原生堆剖析的配置和归因查询 |

## 对测试服压一轮

```bash
# 1. 在后端容器里建压测会话并签令牌（先把脚本 docker cp 进容器）
PERF_REMOTE_DATABASE=circle PERF_ENV_FILE=/app/.env.production \
  node seed-perf-load.cjs > accounts.local.json

# 2. 开一条到后端容器的隧道：发压绕开 Caddy，否则只会测到按 IP 的限流
ssh -N -L 13100:<后端容器 IP>:3000 <测试服>

# 3. 阶梯加压到失败率超过 5% 为止
PERF_ACCOUNTS=accounts.local.json PERF_CLIENT_ROOT=<前端仓库检出> \
PERF_SSH=<测试服> PERF_HEALTH_URL=https://<api 域名>/healthz \
  ./run-load-steps.sh "50:5000 100:5000 200:5000 250:5000"
```

每个虚拟用户带自己的转发地址头，后端按「每人一个 IP」限流，和真实分布一致。

## 查一条消息慢在哪

- **往返次数**：临时 `ALTER SYSTEM SET log_min_duration_statement = 0` 和 `log_parameter_max_length = 0`（不记参数），发十几条消息，`RESET` 后把这段数据库日志交给 `pg-log-per-message.cjs`。
- **CPU 去向**：`docker kill --signal=SIGUSR1 <后端容器>` 打开调试口，在容器里跑 `cpu-profile-in-container.cjs 30`（结束时自动关调试口），再用 `cpuprofile-summary.cjs` 汇总。

## 已知的局限

- `load-chat.cjs` 只发文本消息，不回已读和送达回执，也不发图片视频。
- 本机多实例压测只能证明功能正常：发压进程、数据库和后端抢同一批核，扩展倍数测不准。
- 后端仓库不依赖 `socket.io-client`，发压时从 `PERF_CLIENT_ROOT` 指向的目录借。
