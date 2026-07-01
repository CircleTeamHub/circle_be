# 信誉发言闸门（Credit Send-Gate）

低信誉用户（`creditScore < 60`）暂时无法发送消息。本文记录整条链路与几个**重新接手时容易踩的坑**。

## 三层结构

```
[App 客户端]                 [OpenIM Server]                 [circle_be]
assertLocalCanSendMessage  ──before-send webhook──►  /api/v1/openim-callback/*
  仅 UX 预检（可绕过）                                   CreditPolicyService（权威）
```

1. **客户端（circle-im）** `src/services/api/credit-policy.ts`
   `assertLocalCanSendMessage()` 读本地 store 的 `creditScore`，在 `im/client.ts` 的 `reportSend`（所有发送变体的必经点）里调用。
   **仅是 UX 预检**：给正常用户即时提示，**可被绕过**（改本地 store / 旧客户端 / 直连 OpenIM）。不承担强制职责。

2. **OpenIM before-send 回调** → `openim-docker` 的 `webhooks.yml`（用 `IMENV_WEBHOOKS_*` env 覆盖）
   每条消息发送前，OpenIM POST 到 circle_be。这是**唯一拦得住的强制点**——因为消息走 OpenIM、不经 circle_be 的普通接口。

3. **服务端（circle_be）** `src/credit/`
   - `openim-credit-callback.controller.ts`：`callbackBeforeSendSingleMsgCommand` / `callbackBeforeSendGroupMsgCommand`，读 `body.sendID`，返 allow / deny。
   - `credit-policy.service.ts`：`checkOpenimSend()`，带 15s 内存缓存 + 写时失效。
   - `openim-callback.guard.ts`：可选 `OPENIM_CALLBACK_SECRET` 鉴权（默认靠网络隔离）。

## 坑位（务必对齐，配错=静默放行）

| 坑 | 事实 |
|---|---|
| **回调 URL 必须带全局前缀** | circle_be 在 `setup.ts` 设了 `app.setGlobalPrefix('api/v1')`，无 exclude。真实路径是 `/api/v1/openim-callback/...`，不是 `/openim-callback/...`。 |
| **URL 拼接方式** | OpenIM Go 源 `http_client.go`：`fullURL = url + "/" + command`。所以 `IMENV_WEBHOOKS_URL` 只填**基址**（`.../api/v1/openim-callback`），命令由 OpenIM 追加。 |
| **不能用 `?token=` 鉴权** | 命令追加在 url 之后，query 会被 `/command` 截断；OpenIM 也不发自定义 header。故 guard 密钥这条路不通，现阶段 `OPENIM_CALLBACK_SECRET` 留空 + 网络隔离。 |
| **Linux 上 `host.docker.internal` 不解析** | 仅 Docker Desktop 有。compose 里已加 `extra_hosts: host.docker.internal:host-gateway`。 |
| **⚠️ 实为 fail-CLOSED（重要）** | `failedContinue` 在 OpenIM 3.8.x 源码里**只有字段、从未被读取**（`pkg/common/config/config.go` 是唯一出现处）。回调失败（circle_be 宕机/超时）时 `WithCondition` 原样上抛错误 → **消息发送失败**。即 circle_be 一挂/一慢就阻塞全体消息。上线前务必实测镜像实际行为（停 circle_be 发消息看是否被拦）。 |

## 缓存与失效（性能）

- `checkOpenimSend` 每用户 15s 才查一次库，其余走内存 Map —— **不是每条消息查库**。
- **写时失效**：`credit.service.ts` 改分（唯一写 `creditScore` 处）后，在**提交后**钩子 `broadcastCreditProfileChanged` 里调 `invalidateUserPolicyCache`。扣分/加分即刻生效，15s TTL 只是兜底。
- 失效放在提交后（非事务内），避免回滚误失效 + 并发 callback 读到未提交旧值再缓存的竞态。

## 启用（部署）

两个 compose 栈（circle_be 的 `docker-compose.prod.yml`、`openim-docker`）跑在同一台机。回调走**共享内网** `shared-im`，不经公网 3000：

1. 一次性建共享网络：`docker network create shared-im`
2. 两个栈都已把服务接入 `shared-im`（circle_be 的 `circle_be`、openim 的 `openim-server`）。
3. `openim-docker/.env` 的 `CIRCLE_CALLBACK_URL="http://circle_be:3000/api/v1/openim-callback"`（服务名直连）。
4. `docker compose up -d`（两个栈都重启，让网络接入与 env 生效）。
5. 验证：用 `creditScore < 60` 账号发消息应被拦；`docker logs openim-server` 有回调 POST，circle_be 收到 `/api/v1/openim-callback/*`。

> 退路（暂不接内网）：`CIRCLE_CALLBACK_URL` 改回 `http://host.docker.internal:3000/api/v1/openim-callback`（openim-server 已配 `extra_hosts: host.docker.internal:host-gateway`，Linux 亦可）。缺点：经公网 3000，见下。

**安全**：内网方案下回调不暴露公网。若用 host.docker.internal 退路，回调端点会经公网 3000 可达——该端点只读（返 allow/deny、不改状态、绕不过闸门），但会泄露"某人是否低分"、可被打 DB（15s 缓存兜底）。正式环境优先内网，或限制 `/api/v1/openim-callback` 来源。

## 阈值

FE `SEND_MESSAGE_MIN_SCORE = 60`（`credit-policy.ts`）是 BE `CREDIT_POLICY_MIN_SCORE.SEND_MESSAGE = 60`（`credit-policy.service.ts`）的**镜像**，改动需两处同步。BE 是权威。
