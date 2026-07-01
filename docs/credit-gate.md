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
| **fail-open 是有意的** | `failedContinue: true`：circle_be 挂了消息**照发**（可用性优先）。闸门是尽力而为，非硬拦。要硬拦改 `false`（但会全员发不出）。 |

## 缓存与失效（性能）

- `checkOpenimSend` 每用户 15s 才查一次库，其余走内存 Map —— **不是每条消息查库**。
- **写时失效**：`credit.service.ts` 改分（唯一写 `creditScore` 处）后，在**提交后**钩子 `broadcastCreditProfileChanged` 里调 `invalidateUserPolicyCache`。扣分/加分即刻生效，15s TTL 只是兜底。
- 失效放在提交后（非事务内），避免回滚误失效 + 并发 callback 读到未提交旧值再缓存的竞态。

## 启用（部署）

1. `openim-docker/.env` 设 `CIRCLE_CALLBACK_URL`（含 `/api/v1/openim-callback`），按部署改 host（同机宿主 `host.docker.internal:3000` / 同网络容器用服务名）。
2. `docker compose up -d openim-server` 重启。
3. 验证：用 `creditScore < 60` 账号发消息应被拦；`docker logs openim-server` 有回调 POST，circle_be 收到 `/api/v1/openim-callback/*`。

## 阈值

FE `SEND_MESSAGE_MIN_SCORE = 60`（`credit-policy.ts`）是 BE `CREDIT_POLICY_MIN_SCORE.SEND_MESSAGE = 60`（`credit-policy.service.ts`）的**镜像**，改动需两处同步。BE 是权威。
