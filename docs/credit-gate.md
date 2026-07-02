# 信誉与发言/互动限制（Credit Gate）

**决策（Option A）**：信誉强制**不放在聊天层**。聊天只保留客户端 UX 预检；真正的服务端强制落在**本就走 circle_be 的动作**上（发帖互动、活动报名），这些拦住不影响聊天可用性。

## 为什么不在聊天层强制

聊天走 OpenIM、不经 circle_be。要在发消息时服务端强制，只能用 OpenIM 的 before-send 回调。但：

- OpenIM 3.8.x 源码里 `failedContinue` **只有配置字段、从未被读取**（`pkg/common/config/config.go` 唯一出现）。回调失败（circle_be 宕机/超时）时 `WithCondition` 原样上抛错误 → 消息发送失败。
- 即闸门是 **fail-CLOSED**：circle_be 一挂/一慢就阻塞**全体**消息，包括每次部署重启的窗口。
- 用一个软性信誉功能把整个聊天的可用性绑死在 circle_be 上，不划算。故放弃聊天层强制。

> 若将来确实需要聊天层强制：before-send 回调实现（controller + guard + `checkOpenimSend` 缓存）曾建于 `src/credit/`，因长期未启用已删除（见 git 历史），可作为重建起点；但需先 patch OpenIM 让 `failedContinue` 真正生效（fail-open），否则勿在生产开启。

## 现在的两层

### 1. 客户端 UX 预检（circle-im，非强制）
`src/services/api/credit-policy.ts` 的 `assertLocalCanSendMessage()`，在 `im/client.ts` 的 `reportSend` 里调用。读本地 store 的 `creditScore`，低于 60 时**即时提示**用户发不了。
**仅 UX**：可绕过（改本地 store / 旧客户端 / 直连 OpenIM），不承担强制职责。

### 2. 服务端强制：发帖互动 / 报名（circle_be，权威）
`src/circle-plaza/circle-plaza.service.ts`：
- `checkCanInteract()` —— 帖子可设 `creditRestriction`，`viewer.creditScore < creditRestriction` 则不能互动。
- `checkCanSignup()` —— 帖子可设 `signupCreditRestriction`，低于则不能报名。

按帖可配阈值，服务端判定，天然不影响聊天。这是信誉真正"拦得住"的地方。

## 阈值

FE `SEND_MESSAGE_MIN_SCORE = 60`（`credit-policy.ts`）仅用于客户端 UX 预检。发帖/报名的门槛是**按帖配置**的（`creditRestriction` / `signupCreditRestriction`），非全局常量。

## 已清理（删除的死代码）

以下从未接通、已删除，避免误导：
- BE OpenIM before-send 回调整套：`openim-credit-callback.controller.ts`、`openim-callback.guard.ts`、`credit-policy.service.ts`（含 `checkOpenimSend` 15s 缓存）、`OPENIM_CALLBACK_SECRET` 环境变量。OpenIM webhook 从未配置、回调无人调用；将来若要聊天层强制，需先让 OpenIM `failedContinue` 生效再重建（见上）。
- BE `CreditController`（`POST /credit-policy/check`）+ `credit-policy.service.ts#check` + `dto/credit-policy.dto.ts`。
- FE `credit-policy.ts` 的 `assertCanSendMessage` / `checkCreditPolicy` + 15s 缓存/inflight（FE 现只剩 `assertLocalCanSendMessage` 本地拦截）。
