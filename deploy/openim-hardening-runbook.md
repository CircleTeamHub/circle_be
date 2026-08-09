# OpenIM 栈加固 Runbook（#106 / #107 / #110）

服务器上的 `openim-docker/` 是独立上游 clone，不在本仓库内 —— 本仓库只能交付
脚本与流程。**全程需要一次 IM 中断窗口（分钟级）**，自行择时执行。

## 影响预告

- 轮换 `OPENIM_SECRET` 会使**所有已发的 IM token 失效**。客户端已具备原地自愈
  （Circle_frontend PR #120：token 失效自动经 `GET /auth/im-token` 换新重登），
  用户感知为一次短暂重连，不会被登出。
- `docker compose up -d --force-recreate` 期间 IM 收发中断（约 1-3 分钟）。
- circle_be 的 `OPENIM_ADMIN_SECRET` 必须与新 `OPENIM_SECRET` 同值，否则
  circle_be 侧 IM 全断（注册同步、token 签发、群同步）。

## 步骤

```sh
# 0) 预检：确认当前暴露面（记录 before 状态）
ss -tlnp | grep -E '12379|12380|10001|10002|37017|16379'

# 1) 跑加固脚本（只改文件，不重启）
cd ~/circle_be   # 或部署目录
bash deploy/openim-harden.sh ~/openim-docker
# 按输出核对：轮换了哪些密钥、哪些端口已钉回环、剩余暴露端口是否只剩 10001/10002

# 2) 同步 circle_be 配置
#    把脚本输出的 OPENIM_ADMIN_SECRET 新值写进 .env.production

# 3) 宿主机级日志轮转兜底（#107 —— 覆盖两个栈与未来任何容器）
# round 3 review：不要整文件覆盖 —— 宿主机已有 daemon.json（registry mirror /
# live-restore 等）会被抹掉。先备份再合并两个键：
sudo cp /etc/docker/daemon.json /etc/docker/daemon.json.bak.$(date +%s) 2>/dev/null || true
if [ -s /etc/docker/daemon.json ]; then
  sudo jq '. + {"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}' \
    /etc/docker/daemon.json | sudo tee /etc/docker/daemon.json.new >/dev/null \
    && sudo mv /etc/docker/daemon.json.new /etc/docker/daemon.json
else
  sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
fi
sudo systemctl reload docker || sudo systemctl restart docker
# 注意：daemon.json 只对「新创建」的容器生效，下一步的 force-recreate 正好覆盖。

# 4) 重启窗口
cd ~/openim-docker && docker compose up -d --force-recreate
# circle_be 侧：compose 服务名是 circle_be（蓝）/ circle_be_green（绿），
# 只重启当前在役颜色即可（看 Caddy 上游或 docker ps 确认）：
cd ~/circle_be && docker compose -f docker-compose.prod.yml up -d --force-recreate circle_be
# 在役为绿时改用: docker compose -f docker-compose.prod.yml up -d --force-recreate circle_be_green
# 或者干脆走常规发版脚本（自带健康检查与切流）: bash deploy/release-deploy.sh

# 5) OpenIM 栈内存上限
# 已改为由第 1 步的脚本写 ~/openim-docker/docker-compose.override.yml（compose 会自动
# 加载这个文件名）。上一步的 force-recreate 就已经带上了上限，这里只需核对：
docker inspect --format '{{.Name}} mem={{.HostConfig.Memory}}' \
  $(docker ps -q) | grep -Ei 'openim|mongo|kafka|zookeeper|etcd'
# 预期都不是 0，且分两档（脚本按服务名分流，不是统一一个值）：
#   数据面 kafka/mongo/zookeeper/minio → 2147483648（2g，OPENIM_DATA_MEM_LIMIT 默认值）
#   其余 openim-* 服务              → 536870912（512m，OPENIM_SVC_MEM_LIMIT 默认值）
# 额度不合适就改（两档各自独立，脚本不认 OPENIM_MEM_LIMIT）：
#   OPENIM_DATA_MEM_LIMIT=3g OPENIM_SVC_MEM_LIMIT=768m bash deploy/openim-harden.sh ~/openim-docker
#   cd ~/openim-docker && docker compose up -d
#
# 为什么不再用 `docker update --memory`：那只作用于**当前这批容器**，之后任何一次
# force-recreate（升级上游、回滚、重跑本 runbook）都会建出没有上限的新容器，且不报
# 任何错 —— 直到一次消息洪泛把 mongo/kafka 吃爆内存、连业务栈一起拖垮（同机部署）。

# 6) 验证
# 6a. 旧默认密钥必须已失效（预期返回错误）：
curl -s -X POST http://127.0.0.1:10002/auth/get_admin_token \
  -H 'Content-Type: application/json' \
  -d '{"secret":"openIM123","userID":"imAdmin"}' | head -c 200; echo
# 6b. etcd 不再公网可达（本机仍可）：
ss -tlnp | grep -E '12379|12380'      # 预期只见 127.0.0.1
# 6c. 客户端冒烟：app 收发一条消息（token 自愈会自动完成重登）
# 6d. circle_be 侧：日志无 OpenIM auth 错误，/readyz 正常

# 7) #110 —— 打通 OpenIM metrics 抓取
# openim job 现在默认是**启用**的（不再是注释）：聊天消息不经过 circle_be，这是唯一
# 能看见消息吞吐与连接数的地方，关掉它等于恶意刷屏在监控上完全不可见。
#
# ⚠️ 光确认端口号不够：上游 openim-docker 默认**不发布** metrics 端口到宿主机，
# 容器内监听 ≠ Prometheus（在另一套 compose 里，经 host.docker.internal）能抓到。
# 两步都要做：
# 7a. 确认容器内真实端口（版本不同会变）：
grep -rn "prometheusPort\|ports:" ~/openim-docker/config 2>/dev/null | grep -i prom | head
# 7b. 在 ~/openim-docker/docker-compose.yaml 给对应服务加端口映射（用 ${HOST_BIND_IP}
#     前缀，收口后会随之只对内网可见）：
#       ports:
#         - "${HOST_BIND_IP}:20112:20112"   # msggateway
#         - "${HOST_BIND_IP}:20113:20113"   # openim-api
#     加固脚本已把这两个端口放进放行清单，重跑不会把它们钉掉；端口号不同时用
#     OPENIM_METRICS_PORTS="20112 20113" 覆盖，否则下次重跑会把它们收走、监控再次变瞎。
# round 3 review：生产 compose 挂载的是 prometheus.prod.yml（覆盖容器内
# /etc/prometheus/prometheus.yml）——生产环境改 prod 文件，dev 才改 prometheus.yml。
# 端口对不上时不会污染别的 job，只会让 OpenIMMetricsUnreachable（warning）响；
# 它被有意排除在 critical 的 TargetDown 之外，理由见 monitoring/prometheus/alerts.yml。
# 填好后:
docker exec circle-prometheus kill -HUP 1   # 或 curl -X POST localhost:9090/-/reload
# 验证抓到了:
curl -s localhost:9090/api/v1/targets | grep -o '"job":"openim"[^}]*"health":"[a-z]*"' | head

# 7b) 消息大小上限（第 1 步的脚本已自动写入，这里核对）
grep -n websocketMaxMsgLen ~/openim-docker/config/openim-msggateway.yml
# 预期 16384（上游默认 4096 对含 @提及 / 引用的正常消息偏紧）。
# 需要别的值：OPENIM_MAX_MSG_LEN=32768 bash deploy/openim-harden.sh ~/openim-docker
#
# 这是服务端唯一能安全强制消息大小的地方。客户端映射层也有 8000 字的渲染截断，
# 但那只保护自家用户、拦不住「发出去」那一侧。
# 为什么不用 before-send webhook 做内容校验：OpenIM 的 webhook 客户端直接上抛回调
# 错误，`failedContinue` 只是个从未被读取的配置字段（2026-08 复核 openim-server
# main 的 pkg/common/webhook/http_client.go，仍然如此）。于是回调是 fail-CLOSED——
# circle_be 一挂或一慢就阻塞全体消息，连部署重启的窗口都算。详见 docs/credit-gate.md。

# 8) 收口（域名 + Caddy 就绪后才做，做完客户端不能再直连网关）
# 前置 8a：客户端已发版到 wss://<域名>/openim-ws + https://<域名>/openim-api
# 前置 8b：Caddy 必须先换成带 rate_limit 模块的自建镜像。不换的话 Caddyfile 里的
#          rate_limit 是未知指令 —— 发版时 caddy validate 直接失败、拒绝切流，
#          而且 caddy 一旦重启就 crash-loop（公网入口整个消失）。
#          release-deploy.sh 已加前置检查会拦住，但这一步要主动做：
cd ~/circle_be
docker compose -f docker-compose.prod.yml build caddy
docker compose -f docker-compose.prod.yml up -d --force-recreate caddy
docker compose -f docker-compose.prod.yml exec -T caddy caddy list-modules | grep rate_limit

# 8c：收口。⚠️ 绑定地址是 docker bridge 网关（如 172.17.0.1），**不是 127.0.0.1**：
# Caddy 在容器里经 host.docker.internal 回连宿主机，绑回环 = Caddy 也连不上 =
# 刚迁过来的客户端 100% 中断，而 ss 看着一切正常。脚本会自动探测 bridge IP。
bash deploy/openim-harden.sh ~/openim-docker --collapse-public-ports
cd ~/openim-docker && docker compose up -d --force-recreate

# 8d：验证。ss 只能证明「公网关上了」，证明不了「Caddy 还连得上」——两件事必须都查。
ss -tlnp | grep -E '10001|10002'   # 预期是 bridge IP，不是 0.0.0.0
curl -sS https://<API_DOMAIN>/openim-api/ -o /dev/null -w '%{http_code}\n'
# 期望 OpenIM 自己的应答（4xx / JSON 错误都算通过）。502 = 上游不可达，
# 立刻回滚（把 .env 的 HOST_BIND_IP 改回去 + force-recreate）再排查。
```

## 回滚

```sh
cd ~/openim-docker
cp .env.bak.<时间戳> .env
cp docker-compose.yaml.bak.<时间戳> docker-compose.yaml
docker compose up -d --force-recreate
# circle_be 侧恢复旧 OPENIM_ADMIN_SECRET 并重启
```

## 遗留（有意不在本次覆盖）

- `HOST_BIND_IP` 仍为 0.0.0.0：10001/10002 测试期必须直连（无域名/无 TLS）。
  收口已脚本化，见上面第 8 步（`--collapse-public-ports`）—— 但**必须等客户端发版
  改走域名之后再执行**，否则 force-recreate 当场断掉所有直连客户端。
  收口前 Caddyfile 里的 rate_limit 全部被绕过，等于不存在。
- Tencent 安全组若已挡 12379/12380/37017/16379，上面第 6b 步会提前显得"已经
  安全"—— 仍建议完成回环绑定（纵深防御，安全组误改不再等于门户洞开）。
