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

# 5) OpenIM 栈内存上限（#107；docker update 对运行中容器即时生效，重启后仍保留）
docker ps --format '{{.Names}}' | grep -Ei 'openim|mongo|kafka|zookeeper|etcd' \
  | xargs -I{} docker update --memory 1g --memory-swap 1g {}

# 6) 验证
# 6a. 旧默认密钥必须已失效（预期返回错误）：
curl -s -X POST http://127.0.0.1:10002/auth/get_admin_token \
  -H 'Content-Type: application/json' \
  -d '{"secret":"openIM123","userID":"imAdmin"}' | head -c 200; echo
# 6b. etcd 不再公网可达（本机仍可）：
ss -tlnp | grep -E '12379|12380'      # 预期只见 127.0.0.1
# 6c. 客户端冒烟：app 收发一条消息（token 自愈会自动完成重登）
# 6d. circle_be 侧：日志无 OpenIM auth 错误，/readyz 正常

# 7) #110 —— 确认 OpenIM metrics 端口后启用抓取
grep -rn "prometheusPort\|ports:" ~/openim-docker/config 2>/dev/null | grep -i prom | head
# round 3 review：生产 compose 挂载的是 prometheus.prod.yml（覆盖容器内
# /etc/prometheus/prometheus.yml）——生产环境改 prod 文件，dev 才改
# prometheus.yml；两个文件里都留了同款 openim job 模板注释。填好后:
docker exec circle-prometheus kill -HUP 1   # 或 curl -X POST localhost:9090/-/reload
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
  域名 + Caddy 反代就绪后，把 `.env` 的 `HOST_BIND_IP` 切成 `127.0.0.1` 并
  force-recreate，即完成最后一步收口（届时客户端走 wss://域名/openim-ws）。
- Tencent 安全组若已挡 12379/12380/37017/16379，上面第 6b 步会提前显得"已经
  安全"—— 仍建议完成回环绑定（纵深防御，安全组误改不再等于门户洞开）。
