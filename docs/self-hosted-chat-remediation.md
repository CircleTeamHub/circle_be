# 自研聊天栈 —— 迁移缺口清单与补齐计划

> 配套文档：[self-hosted-chat.md](./self-hosted-chat.md)（协议契约与架构）。
> 跨仓：本计划同时覆盖 `circle_be`（BE）、`circle-im`（App）、`temp-chat-web`（访客网页）。
> 成文日期：2026-08-09。基线（当日晚更新）：**BE `feat/self-hosted-im` 已经
> PR #138 squash 合入 main**（+#139 群鉴权加固），FE main 到 #148 —— 两仓 main
> 已对齐。批 0 / 批 0.5 已在双仓 `feat/chat-remediation` 分支落地（见 §4）。

## 0. 这份文档为什么存在

拆 OpenIM 时，`self-hosted-chat.md` 的「Phase 2+ 待办」列了 6 条，**全部是服务端视角**
（群同步 / 推送 / temp-chat / 媒体 / 多实例 / 词表），一条客户端能力都没有。那份清单是
从「网关还缺什么」倒推的，于是 OpenIM SDK **免费提供**的那一整层（本地 SQLite、撤回、
真引用、全局未读、成员变更事件）在迁移里没有任何人认领。

> **教训**：换掉一个自带电池的 SDK 时，逐个方法找替代是不够的 —— 要连同「方法背后的
> 基础设施」一起清点。旧代码里 `searchLocalMessages` / `getAdvancedHistoryMessageList` /
> `insertSingleMessageToLocalStorage` / `deleteMessageFromLocalStorage` 有一半名字里带
> `Local`，替代物却一律指向了 REST：功能对上了，`Local` 这两个字丢了没人报错。

本文档是对旧栈 **48 个 SDK 方法 + 15 个事件 + 23 个 BE OpenIM API** 逐个对照后的完整
结果，以及每一项的补齐方案。

> 2026-08-09 晚做了**第二轮全量复核**（4 路并行：FE 新栈能力面 / FE 旧栈 git 史挖掘 /
> BE 现状 / temp-chat-web），补入 G-13~G-18 与 S-05，并新增 §8（查过且排除的疑似缺口，
> 防止后人重查）与 §9（顺带清理项）。

---

## 1. 完整缺口清单

### G-01 本地持久化缺失 —— 影响面最大

`circle-im/src/chat-core/store.ts` 是纯内存 zustand，**没有 persist**。落盘的只有偏好、
分组、本地未读覆盖、删除墓碑。内存窗口封在 `MESSAGES_CAP = 200`。

OpenIM SDK 内部就是 SQLite，冷启动秒开、离线可翻历史。现在：冷启动必须等 REST 回来才有
内容、断网进 App 是空的、弱网体验整体退化。

`deleted-messages.ts` 那个 5000 条上限 + 「淘汰即复活」的设计，就是硬拿 KV 当数据库用挤
出来的产物。

> 顺带说明为什么方向被带偏：`circle-im/docs/storage-mmkv.md` 是全仓唯一提到 SQLite 的
> 地方，而且是**负面语境**（「走 Bridge / SQLite」是 AsyncStorage 慢的原因）。那个结论
> 对 KV 场景成立，但它让「本地持久化 = MMKV」成了默认 —— 而同一份文档自己也写了 MMKV
> 「不是数据库，不适合存大量结构化记录或做复杂查询」。

### G-02 消息撤回缺失

两仓搜 `撤回` / `recall` / `revoke` 在 chat 代码里 0 命中。旧栈有 OpenIM 的
`RevokeMessage`（`circle-im/src/im/mappers.ts` 里专门处理过）。

现在的「删除」只是 `deleted-messages.ts` 的本地墓碑，**对端照样看得见** —— 从「双方都
撤掉」退成「我自己眼不见」。

### G-03 搜索退化

`chat.service.ts` 的 `searchAllMessages` 用
`content: { path: ['text'], string_contains }`，而 `ChatMessage` 只有：

```
@@unique([conversationID, height])
@@unique([conversationID, senderID, clientMessageId])
@@index([conversationID, createdAt])
```

**这个查询一个索引都用不上**，是全表 jsonb 扫描；且大小写敏感（代码注释自认「拉丁小写化
随后续全文索引批次」，未做）。旧栈是本地 SQLite 搜索：离线、瞬时。

### G-04 不能水平扩展

`@socket.io/redis-adapter` 未安装 → 只能单实例。另有四处进程内状态（见 §2.4）。

### G-05 发送吞吐

`chat.service.ts:209` 的事务：`pg_advisory_xact_lock(7301, hashtext(convId))` →
`aggregate max(height)` → `create` → 更新会话 → 取消隐藏。同会话完全串行，且 `hashtext`
碰撞会让**无关会话互等**。

### G-06 大群热路径

每条消息都跑的两个重操作：
- `ChatPushService.listSeats` 全量翻座位（`PUSH_SEAT_PAGE = 500`，3000 人群翻 6 页）
- `getOnlineUserIdsInConversation` 走 `fetchSockets()` 拉整个房间

另 `listConversations` 的未读是每会话一次 `count`（N+1）。

### G-07 能力面缺失

逐条已读回执（群里"谁读了"）、已送达回执、表情回复、消息编辑。

### G-08 推送通道

改走 Expo Push（`exp.host` 中转），best-effort 直发、不落库不重试。多一层第三方。
（这一条是有意的取舍，记录备查，不在本轮补齐范围。）

### G-09 引用消息退化成文本快照

`quote` 类型的 content 是 `{text, quotedText}` —— 引用的文本被**复制**进新消息。
`replyToId` 字段落库了，但**只写不读**：全仓唯一写入点是
`circle-im/src/features/chat/screens/ChatDetailScreen.tsx:2596`，读路径 0 命中。

旧栈是 `createQuoteMessage` + `findMessageList` 真引用。后果：
- 点引用不能跳原消息
- 引用图片 / 语音只剩一行字符串
- 原消息删了引用还在

### G-10 消息 tab 红点依赖屏幕挂载

`setMessagesUnread` 全仓唯一调用点在
`circle-im/src/features/messages/screens/MessagesScreen.tsx:665`。

冷启动落在别的 tab → **红点恒为 0**，直到用户自己点进消息页。旧栈是 SDK 全局的
`onTotalUnreadMessageCountChanged`，与任何 UI 挂载无关。

### G-11 客户端收不到任何会话/成员变更事件

旧栈有四个事件：`onNewConversation` / `onJoinedGroupDeleted` / `onGroupMemberDeleted` /
`onGroupMemberInfoChanged`。新栈**一个都没有**。

`ChatBroadcastService.emitToUser`（`chat-broadcast.service.ts:114`）注释写着「如会话新建 /
成员变更时通知个人房」，但**零调用点** —— 口子留了没接。

后果：被踢出圈子的人 UI 上一直停在群里，直到自己退出重进。

### G-12 被踢后有 ≤1min 的收消息窗口 —— 权限问题【已闭合】

> **二轮更正**：本节初稿基于早期分支状态。合入 main 前的 Codex 轮已给三条
> **delete 写点**（踢人 `group.service:350` / 退群 `:445` / 退圈
> `circle.service:492`）加上事务内 `releaseSeatInTx` + 提交后 `detachSeat`
> 即时踢房 —— 被踢者的**收消息窗口在 delete 路径上已经闭合**（对账的
> `updatedAt` 窗口扫不到被删的行，这类只能靠钩子，注释里已写明机理）。
>
> 剩余的真实缺口是**加人侧**：4 处激活路径（拉人进群 `group.service`、担保
> 达标 / 管理员强批 / 补偿重放 `circle-invitation.service` ×3）只靠 ≤1min
> 对账入座 —— 新成员一分钟内没有座位、收不到群消息。以及所有路径都没有
> 个人事件面（G-11）。
>
> **批 0 已落地（`feat/chat-remediation`）**：4 处激活路径提交后即时幂等
> `ensureCircleConversation`（失败仍由对账兜底）；`chat:conversation`
> 事件面接通（详见 §2.1 落地记录）。

### G-13 断线重连不对账 —— 消息静默丢失窗口

FE 的 `connect` 钩子只做 set 状态 + `flushPendingReads`（`chat-core/socket-manager.ts:79-86`）：
**不重拉会话列表、不补拉缺口**。而 REST 只有 `beforeHeight` 向旧翻页（`chat-core/api.ts:63-81`），
**协议里根本没有「取某 height 之后」的接口**。`dispatcher.ts:93-120` 的 backfill 只在
「收到未知会话的消息」时触发。

后果：断线期间对端发的消息，在**已打开的会话里永远不出现**，会话列表也不更新，
直到下次 focus 重拉或重启。旧栈 SDK 重连自带 seq 增量同步，这层没人认领。

对照：另一条 realtime 栈重连时会 `recoverTabBadgeSnapshot({force})` 对账
（`realtime/client.ts:484-505`），chat-core 没有对应物。

### G-14 清空/删除聊天记录 —— 三个粒度全部回归

旧栈三个真实入口，新栈全断：

| 旧入口 | 旧实现 | 新状态 |
|---|---|---|
| 会话资料页「清空聊天记录」 | `clearConversationAndDeleteAllMsg`（旧 ChatInfoScreen:1160） | **入口整个没了**（新 ChatInfoScreen 行项里无此项） |
| 会话列表滑动「删除」 | `deleteConversationAndDeleteAllMsg`（旧 MessagesScreen:788） | 只 `hidden:true`，历史原样在（`MessagesScreen.tsx:770-796` 注释自认「等价于隐藏」） |
| 设置页「清理本地聊天记录」 | `deleteAllMsgFromLocal` + 未读清零 | `clearCachedChats` 只清内存（`store.ts:391-399`），随后 `loadChatConversations` 又全拉回来 —— **假清空** |

服务端也无任何配套：无 clear 端点；`ChatMessage.deleted` 字段所有读路径都过滤
（`chat.service.ts:308` 等 7 处），但**全仓零写入点**。

### G-15 多端未读不同步（FE 半接）

BE 侧数据已经在线上：`chat:read` 广播给整个会话房、刻意不 except 自己的其它 socket
（`chat-broadcast.service.ts:34-40`，对比 `emitTyping` 显式 `.except()`）。
但 FE `applyRead` 只写 `readWatermarks`、从不比对 `currentUserId`、不动 `unreadCount`
（`dispatcher.ts:170-188`、`store.ts:378-389`）。

结果：另一台设备读完，本机红点不动。连带：`pendingReads` 是内存 Map
（`socket-manager.ts:29`），App 被杀丢失未上报水位，对端一直显示未读。

### G-16 客服中心指向已消失的 imAdmin

`SUPPORT_ACCOUNT_ID` 默认 `'imAdmin'`（`circle-im/src/constants/config.ts:210-211`）
是 OpenIM 内置管理员账号，自研栈里**没有这个 User 行** —— env 不配则客服中心开单聊必失败。

已在 `feat/support-agent-config` 以「管理台可配置客服账号」方案处理
（`circle-im/docs/superpowers/specs/2026-08-09-support-agent-config-design.md`），
本清单挂账不重复排期。

### G-17 存量数据割接没有方案 —— 部署级【已拍板:路线 2,接受历史清零】

全仓**没有任何** OpenIM→ChatMessage 的数据迁移脚本（`scripts/` 与 `prisma/migrations`
均无）。直接切栈 = 线上用户的历史消息、会话列表全部清零。两条路必选其一，
**不能默认沉默丢失**：

1. 写迁移：OpenIM Mongo 消息 → 三表；height 按各会话 seq 升序重排；
   `si_`/`sg_` 会话 id → 新 uuid 映射。
2. 明确拍板「测试期接受历史清零」并留档。

> **拍板（2026-08-09，用户决定）：走 2。** 测试期用户量小，聊天历史不迁；
> 用户/好友/圈子等业务数据全在 Postgres，不受影响。曾评估过的迁移通道备查：
> 不碰 Mongo 内部，经 OpenIM 管理端 HTTP API（`/msg/pull_msg_by_seq` +
> `get_conversations_has_read_and_max_seq`，旧 `chat-history` 模块的成熟路径，
> git 历史 `70d9e60^` 可寻），height 可直取 seq。哪天要补迁移从这里起步。
>
> **割接清单（切生产时执行，建议进 DEPLOY.md 阶段 5）：**
> 1. `mongodump` 全库留底（哪天要找回历史还有原始数据），归档到备份桶；
> 2. `npx prisma migrate deploy`（本轮共 4 个新迁移）；
> 3. 清掉会话分组里的 OpenIM 旧 id（否则用户的自定义分组永远是空组）：
>    `DELETE FROM "ConversationGroupMembership" WHERE "conversationID" LIKE 'si\_%' OR "conversationID" LIKE 'sg\_%';`
> 4. 冒烟通过后 `openim-docker down` 退役（既有步骤）；
> 5. 事后清理项：`user/user-id-alias.ts` 兼容层可删（见 §9）。

连带两处旧 id 残留，割接时一并处理：
- `conversation-groups`（会话分组）线上行里存的成员是 OpenIM conversationID
  （`si_`/`sg_` 形状，`conversation-group/dto:37` 注释还在说 OpenIM）——不迁 = 永远空组
- `user/user-id-alias.ts` 去连字符兼容层，割接完成后可删

### G-18 iOS 图标角标回归

旧栈每次发送带 `offlinePushInfo.iOSBadgeCount:true`（旧 `im/client.ts` 15 处），
OpenIM 推送侧累加系统角标。新推送 payload 只有 `{title, body, data}`
（`notification-push.service.ts:454-462`，无 `badge` 字段），FE 也无
`setBadgeCountAsync`（全仓 0 命中）→ App 杀后台时图标角标永远不变。

### 语义被替换（不是缺失，是变了）

| 项 | 旧（OpenIM） | 新 | 差异 |
|---|---|---|---|
| **S-01 阅后即焚** | `setConversationBurnDuration`：会话级、单方设置双方生效、真删 | `UserPrivacySetting.messageSelfDestructDays`：查看者自己的界面过滤，默认 2 天，库里不删、对端不受影响 | 完全两回事 |
| **S-02 群成员管理** | OpenIM group API，实时 | Circle 表 + 每分钟对账 | 一致性更强（单一事实源），实时性更差 |
| **S-03 在线状态** | `subscribeUsersStatus` 订阅任意用户 | `chat:presence` 仅广播到**会话房** | 无共同会话的人拿不到推送 |
| **S-04 引用消息** | 真引用（见 G-09） | 文本快照 | 见 G-09 |
| **S-05 多端在线** | `onKickedOffline` 单端互踢（「已在其他设备登录」终态） | `MAX_SOCKETS_PER_USER = 10` 多端共存 | 共存是升级，但未读/已读同步没跟上（G-15） |

---

## 2. 补齐方案

### 2.1 G-12 + S-02：成员变更实时化（权限优先）【已落地】

**落地记录（2026-08-09，`feat/chat-remediation` 双仓）**：

1. **加人侧即时化**：4 处激活路径（`group.service` 拉人进群；
   `circle-invitation.service` 担保达标 / 管理员强批 / 补偿重放）提交后
   `void ensureCircleConversation(circleId)`，失败留给每分钟对账兜底。
   删除侧此前已有事务内钩子（见 G-12 更正），无需再补。
2. **`chat:conversation` 事件**（个人房定向，走 `emitToUser` —— 那个死方法
   正是为此留的口子）：

   ```ts
   { kind: 'joined' | 'left' | 'removed' | 'updated', conversationId, userId }
   ```

   发射点收在 sync 服务：ensure 的 toJoin→`joined` / toRemove→`removed`；
   `detachSeat` 按语义带 kind（踢人=`removed`、退群退圈=`left`）；
   `evictAllSeats`（解散/停用）→`removed`。`updated` 预留无生产方。
3. **FE 消费 + 防复活**：`removed`/`left` 即时收走会话，正看着的群被移出时
   弹 `im.conversation.removedFromGroup`（×5 语种）；有界防复活集合挡住
   离房前一瞬迟到的广播（不入库、不触发补拉），`joined` 解除标记并补拉元信息。
   原方案的「客户端逐条查成员表」改为这个更便宜的等价物。

**验收（已由测试覆盖）**：踢人后被踢者在线端 ≤1s 内不再收到该群消息（delete
钩子 + 房间即时移除），UI 即刻反映（事件 + 防复活）；新成员入座不再等对账。

### 2.2 G-01 + G-03 + G-10：本地持久化（最大件）【代码已落地，待 prebuild + 真机冒烟】

**依赖**：`expo-sqlite`（native module → 需要 `prebuild` + 重建 + 重装真机；
`ios/` `android/` 本来就是 gitignore、每次生成）。项目已在跑 dev-client，路径是通的。

**表结构**（本地，镜像服务端）：

| 表 | 用途 |
|---|---|
| `conversations` | 会话列表快照 |
| `messages` | 消息本体，主键 `id`，`(conversationId, height)` 唯一索引 |
| `messages_fts` | FTS5 虚表，`content=messages`，索引 text/quotedText |
| `sync_state` | 每会话已同步的 height 区间（`minHeight` / `maxHeight`） |
| `tombstones` | 从 MMKV 迁移过来的删除墓碑（**上限与淘汰逻辑整个删掉**） |
| `outbox` | 待发送/发送失败消息 + 未上报的已读水位（现在的 `pendingReads` 是内存 Map，App 被杀即丢） |

**outbox 顺带补重发入口**：失败气泡的标记目前是纯静态（`bubbles/shared.tsx:36`，无
onPress）。`client.ts:159` 与 `protocol.ts:26` 写明「重试复用同一 `d`，服务端幂等兜底」，
但这条链路**零调用方** —— 幂等键设计空转。失败标记加点按重发，走既有 `d`；App 重启后
outbox 里的失败消息仍可见可重发（旧栈 SDK 落库故有此行为，新栈纯内存做不到）。

**读路径反转**：先读本地立刻渲染 → 再拉 REST 按 `height` 对账。
`height` 是我们自己定义的单调序号，补拉天然幂等 —— **这一点自研栈比 OpenIM 好做**
（OpenIM 的 seq 是黑盒）。

**写路径单一入口**：`chat:msg` 广播和 send ack 走同一个落库函数，避免两条路径写出不同形状。

**搜索改本地 FTS5**：服务端的 `searchAllMessages` 降级为兜底（本地没同步到的历史）。
顺带解掉 G-03 的大小写敏感问题。

**G-10 顺带解决**：未读汇总从 `MessagesScreen` 挪进 chat-core store，在 `setConversations` /
`chat:msg` / `markRead` 三处更新，直接写 `tabBadgeStore`。冷启动从 SQLite 秒出。

**加密**：MMKV 整库已 AES 加密，SQLite 要对齐 —— 用 SQLCipher（`expo-sqlite` 支持情况需
落地时确认）；密钥复用 `circle-im-mmkv-encryption-key` 的同款方案（SecureStore 存 32 字节
随机 key）。若 SQLCipher 不可用，则**消息表不落敏感字段明文**这条底线要单独设计，不能默认
明文落盘。

**缓存淘汰**：按会话保留最近 N 条 + 最近 M 天，超出部分删本地不删服务端；翻页触底时回落
REST。避免本地库无限膨胀。

**验收**：飞行模式冷启动能看到会话列表和最近历史；搜索离线可用；红点冷启动即准。

### 2.3 G-02 + G-09 + S-04：撤回与真引用（强耦合，必须一起）【已落地】

> **落地记录（2026-08-09，`feat/chat-remediation` 双仓）**：撤回走 `chat:revoke`
> 事件（ack + 会话房广播 `{conversationId, messageId, revokedBy}`），发送者 2 分钟
> 窗、圈主/管理员无窗口；撤回仍占 height，content 落库清空，媒体对象按 key 尽力
> 删除（UploadService 首条删除路径，storage-reclamation 哨兵已更新）。真引用为
> `replyTo{id,height,senderNickname,type,preview,revoked}` 快照（getHistory 与发送
> ack/广播一次 IN 批量附带），FE 引用块可点击定位（内存窗口内；更早历史待批 1
> 本地库后升级「拉一页再滚」）；原消息撤回 → 引用块同步「消息已撤回」。
> 错误码 3 枚 + 词条 ×5 语种齐。原方案如下，备查：

**撤回（G-02）**：
- `ChatMessage` 复用现有 `deleted Boolean`，加 `revokedAt DateTime?` + `revokedBy String?`
- socket 事件 `chat:revoke` `{conversationId, messageId}`，广播到会话房
- 权限：发送者本人（时间窗，如 2 分钟）或群管理员/圈主
- 读路径：撤回的消息**仍占 height**（不能塌陷坐标系），content 替换成
  `{kind: 'revoked', revokedBy}`，前端渲染成灰条
- 媒体消息撤回时一并删对象存储

**真引用（G-09 / S-04）**：
- BE `getHistory` 批量带回被引用消息快照
  `replyTo: {id, height, senderNickname, type, preview}` —— 一次 `IN` 查询，不 N+1
- FE `message-mappers` 消费 `replyTo`，渲染可点击引用块
- 点击按 `height` 定位；不在当前内存窗口就拉一页再滚过去
- 原消息被撤回 → 引用块显示「消息已撤回」**（这就是两件事必须一起做的原因）**

### 2.4 G-04：水平扩展【已落地】

装 `@socket.io/redis-adapter`，在 `ChatGateway.attach()` 里
`io.adapter(createAdapter(pub, sub))`；Redis 未配置就跳过（保住单实例可跑）。

**adapter 只解决广播，四处进程内状态必须一起改**：

| 现状 | 多实例下的问题 | 改法 |
|---|---|---|
| `connectionsByUser` Map（`MAX_SOCKETS_PER_USER = 10`） | 变成 10×N | Redis `INCR`/`DECR` + TTL 兜底进程崩溃 |
| `SlidingWindowRateLimiter` | 每实例独立计数，限流等比放宽 = 形同虚设 | Redis ZSET 滑动窗口（`ZADD` + `ZREMRANGEBYSCORE` + `ZCARD`，单 Lua 脚本原子化） |
| `getOnlineUserIdsInConversation` / `isUserOnline` | `fetchSockets()` 变跨节点 RPC，大群里很贵 | 见 §2.5，改 Redis Set |
| `joinUserToConversation` / `removeUserFromConversation` | adapter 下自动跨节点生效，频次低 | 不改 |

`expiryTimers`（每实例管自己的 socket）与吊销 pub/sub（本就跨实例）**不用改**。

### 2.5 G-05 + G-06：吞吐与大群热路径【已落地（发号为行锁变体，见下）】

**height 发号（G-05）** —— 换成会话行上的计数器：

- `ChatConversation` 加 `nextHeight Int @default(0)`
- 取号：`UPDATE "ChatConversation" SET "nextHeight" = "nextHeight" + 1 WHERE id = $1 RETURNING "nextHeight"`
- 行锁替掉 advisory lock：临界区从「聚合查询 + 4 次写」缩到「1 次行更新」；`hashtext`
  碰撞导致无关会话互等的问题消失；省掉一次 `ChatMessage` 索引扫描
- 可靠性模型不变（仍是先落库后 ack）
- `assertStillSendable` 的权限复查**不能省**，但可与取号合成一条 CTE，少一次往返

> **迁移必做**：`nextHeight` 初值要回填成各会话现有 `MAX(height)`，不能默认 0，否则
> 新消息会撞 `@@unique([conversationID, height])`。

> 不选 Redis 发号（squady / OpenIM 的做法）：快，但引入 Redis 与 DB 序号不一致的恢复
> 问题（重启需从 DB max 回填）。当前量级不值得。

**大群热路径（G-06）**：

1. `ChatPushService`：把「在线」「免打扰」判定下推到 SQL —— 在线用户从 Redis Set 取出进
   `NOT IN`，`muted` 是现成的列。一条查询只捞真正要推的那几十个人，不再翻 6 页 3000 行。
2. 在线判定改 Redis Set `chat:online:{convId}`（连接 `SADD` / 断开 `SREM`），
   判定用 `SMEMBERS` / `SISMEMBER`。**同时解掉 §2.4 表格第三行。**
3. `listConversations` 的未读 N+1 改一次 `groupBy`。

群人数上限 3000 是产品决定，不是技术天花板，本轮不动。

### 2.6 G-07：能力面【已落地】

| 能力 | 方案 | 备注 |
|---|---|---|
| **逐条已读回执** | `GET /chat/messages/:id/readers`：读者 = `ChatMember.lastReadHeight >= 该消息 height` | **不需要新表**。这是自研栈的红利 —— OpenIM 反倒要单独存回执行 |
| **已送达回执** | `ChatMember` 加 `lastDeliveredHeight`；客户端收到 `chat:msg` 后回 `chat:delivered {conversationId, height}` | 复用现有 pending 已读的节流队列 |
| **表情回复** | 新表 `ChatMessageReaction(messageID, userID, emoji)` + 唯一约束；事件 `chat:reaction` | **不进 height 坐标系** —— 不是消息，不推进未读、不改 `lastMessageAt` |
| **消息编辑** | `ChatMessage` 加 `editedAt` + `contentHistory Json?`；事件 `chat:edit` | 仅发送者、仅 text/quote、2 分钟窗口；**不改 height**（否则排序坐标系要重算） |

### 2.7 S-01：阅后即焚回到会话级【已落地】

- `ChatConversation` 加 `burnDurationSec Int?`（null / 0 = 关）
- 按 OpenIM 语义：**任一方设置即双方生效**
- 开关变更**发一条系统消息留痕**（微信 / Signal 的做法，避免「对方偷偷开了焚毁」）
- 真删走定时任务：软删 `deleted = true` **+ 媒体对象一并删**
  （只软删不删对象存储 = 焚毁只焚了个寂寞）
- **保留** `messageSelfDestructDays`：它是「我自己的界面保留期」，与会话级焚毁不冲突，
  两者**取更严的**
- 访客（临时房）没有 User 行，保留边界仍是房间寿命，不受本项影响
  （见 `chat.service.ts` `getHistory` 里 `applyViewerRetention` 的处理）

### 2.8 S-03：在线状态订阅（低优先级）

`chat:presence` 加订阅面：`chat:presence:subscribe {userIds}`，服务端把这些人加进一个
presence 房。好友基本都有共同会话，实际影响小 —— 排最后。

### 2.9 G-13：重连对账【内存版已落地；sync_state 升级随批 1】

- **BE**：`GET /chat/conversations/:id/messages?afterHeight&limit`（升序返回，复用现有
  查询 + presign 注入；进 §3 契约）。
- **FE** `connect` 钩子补三件事：
  1. 重拉 `listConversations`（一次请求拿到每会话最新 height / 未读 / 末条，列表即准）；
  2. 对**当前打开的会话**按内存（G-01 后为 sync_state）的 maxHeight 做 afterHeight
     补拉，循环到追平；
  3. 补拉与 `chat:msg` 走同一落库入口（G-01 的单一写路径），height 幂等去重。
- G-01 落地后升级为逐会话 `sync_state` 区间对账；落地前先做内存版，**不必等 SQLite**。

**验收**：飞行模式 1 分钟期间对端发 3 条 → 恢复网络 ≤3s，当前会话与列表都齐，无重复。

### 2.10 G-14：清空/删除聊天记录【已落地】

- **Schema**：`ChatMember.clearedBeforeHeight Int @default(0)` —— per-user 可见性水位，
  与旧栈「只清自己、不动对端」语义一致。
- **BE**：`POST /chat/conversations/:id/clear`（水位 = 当前 max height，只前进）。
  `getHistory` / `listConversations` / 搜索全部读路径过滤 `height > clearedBeforeHeight`；
  未读计算的底改为 `max(lastReadHeight, clearedBeforeHeight)`。
- **FE** 三个入口接回：
  1. ChatInfo 加回「清空聊天记录」行（群聊 + 单聊）；
  2. 滑动删除会话 = `hidden` + clear（对齐旧 `deleteConversationAndDeleteAllMsg`）；
  3. 设置页「清空全部聊天」逐会话 clear —— 或改文案为「仅清本地缓存」，二选一，
     **不能再假清空**。
- 不做物理删除（那是撤回/焚毁的事），水位过滤即可，无历史包袱。

### 2.11 G-15：多端未读同步【已落地】

- **FE**：`applyRead` 里 `userId === currentUserId` 时，把该会话 `unreadCount` 收敛到
  `max(0, latestHeight - height)` 并更新 tab 汇总。BE 广播语义已正确，**不动**。
- `pendingReads` 落盘随 G-01 的 outbox 表走。

### 2.12 G-18：图标角标【轻方案已落地；推送侧 badge 随批 5】

- **轻方案（先做）**：FE 在前后台切换与未读汇总变化时
  `Notifications.setBadgeCountAsync(总未读)` —— App 活着时角标即准。
- **推送侧**：BE 在 push payload 加 `badge` 需逐收件人算未读总数，配合 G-06 的未读
  `groupBy` 顺带做（同一条聚合），放批 5；在那之前杀后台角标停留在最后一次前台值，
  记录为已知取舍。

（G-16 在 `feat/support-agent-config` 分支处理，G-17 是割接决策 —— 均无 §2 条目。）

---

## 3. 跨仓契约变更点

以下改动**必须两仓同步**，`circle-im/test/chat-core-protocol-contract.test.js` 会在双仓
并排检出时对齐校验；新增事件与错误码要一并补进契约测试。

### 新增 socket 事件

| 事件 | 方向 | 载荷 | 来自 |
|---|---|---|---|
| `chat:conversation` | S→C | `{kind, conversationId, userId}` | §2.1 |
| `chat:revoke` | 双向 | `{conversationId, messageId}` | §2.3 |
| `chat:delivered` | C→S | `{conversationId, height}` | §2.6 |
| `chat:reaction` | 双向 | `{conversationId, messageId, emoji, userId, op}` | §2.6 |
| `chat:edit` | 双向 | `{conversationId, messageId, content}` | §2.6 |

### REST / 推送变更

- `GET /chat/conversations/:id/messages` 增 `afterHeight` 参数，升序增量拉取（§2.9）
- `POST /chat/conversations/:id/clear`（§2.10）
- Expo push payload 增可选 `badge`（§2.12，批 5）

### DTO 变更

- `ChatMessageDto` 增 `replyTo?: {id, height, senderNickname, type, preview}`（§2.3）
- `ChatMessageDto` 增 `revokedAt?: string | null`、`editedAt?: string | null`
- `ChatConversationDto` 增 `burnDurationSec?: number | null`（§2.7）

### 新增错误码（`ChatErrorCode`，需补 5 语种 `serverErrors.*` 词条）

`CHAT_REVOKE_WINDOW_EXPIRED` / `CHAT_REVOKE_FORBIDDEN` / `CHAT_EDIT_WINDOW_EXPIRED` /
`CHAT_EDIT_FORBIDDEN` / `CHAT_NOT_A_MEMBER`

### Schema 变更汇总（BE）

| 表 | 字段 | 来自 |
|---|---|---|
| `ChatConversation` | `nextHeight Int @default(0)` | §2.5（**需回填**） |
| `ChatConversation` | `burnDurationSec Int?` | §2.7 |
| `ChatMember` | `lastDeliveredHeight Int @default(0)` | §2.6 |
| `ChatMember` | `clearedBeforeHeight Int @default(0)` | §2.10 |
| `ChatMessage` | `revokedAt DateTime?` / `revokedBy String?` | §2.3 |
| `ChatMessage` | `editedAt DateTime?` / `contentHistory Json?` | §2.6 |
| `ChatMessageReaction` | 新表 | §2.6 |

> 部署前提醒：本仓 migrate dev 因 shadow DB 问题不可用，一律用 `migrate deploy`；
> `generate` 之后 `dist` 里的 generated client 会静默过期，需手动 cp 并逼重启。

---

## 4. 排期

| 批次 | 内容 | 理由 | 需要 prebuild |
|---|---|---|---|
| **0 ✅** | G-12 + S-02 主动触发（已落地 `feat/chat-remediation`） | **权限漏洞**；改动最小 | 否 |
| **0.5 ✅** | G-13 重连对账（内存版 + afterHeight 接口）+ G-15 多端未读 + G-18 轻方案（已落地，同分支） | **消息静默丢失**用户可感知；三件都是纯接线 | 否 |
| **1 🚧** | G-01 SQLite（含 outbox/重发）+ G-03 FTS5 + G-10 红点 + G-13 升级 sync_state 对账（**代码已落地**，待 prebuild+真机冒烟） | 用户每次开 App 都感知 | **是** |
| **2 ✅** | G-02 撤回 + G-09/S-04 真引用（已落地，同分支） | 强耦合，必须一起 | 否 |
| **3 ✅** | S-01 焚毁语义 + S-02 事件面 + G-14 清空/删除（已落地，同分支） | 语义正确性 | 否 |
| **4 ✅** | G-05 发号 + G-06 热路径 + G-04 adapter（已落地，同分支；发号采 SELECT..FOR UPDATE 行锁变体：复查在取号前，height 无空洞） | 规模 | 否 |
| **5 ✅** | G-07 送达 / reaction / 编辑 / 逐条已读 + G-18 推送侧 badge（已落地，同分支） | 增量能力 | 否 |
| **—** | G-08 推送通道 | 有意取舍，记录备查，暂不动 | — |
| **—** | G-16 客服账号 | 已在 `feat/support-agent-config` 处理 | — |
| **前置 ✅** | G-17 存量割接决策 | **已拍板走清零留档**，割接清单见 G-17 节 | — |

## 5. 前置阻塞

1. ~~`circle_be` 的 `feat/self-hosted-im` 还没合 main~~ **已解除（2026-08-09）**：
   PR #138 已 squash 合入 main（内容与分支 tip 零差异），两仓 main 已对齐。
   批 0 / 批 0.5 基于新 main 在双仓 `feat/chat-remediation` 分支落地。
2. 批次 1 需要 `prebuild` + 重建 + 重装真机。参考既有流程：Expo CLI 认不出真机，走纯
   `xcodebuild` 构建 + `devicectl` 装 / 启动；真机 dev-client 连 Metro 要 Mac 局域网 IP。
3. **G-17 存量割接决策必须发生在自研栈切生产之前**：写 OpenIM→三表迁移脚本，或明确
   拍板「测试期接受历史清零」并留档。`conversation-groups` 里的旧 `si_`/`sg_` id
   两条路都要处理（迁移映射 or 清表）。

## 6. 验收基线

| 缺口 | 通过标准 |
|---|---|
| G-12 | 踢人后被踢者在线端 ≤1s 不再收该群消息，UI 立即反映 |
| G-01 | 飞行模式冷启动可见会话列表 + 最近历史 |
| G-03 | 离线可搜索；拉丁词大小写不敏感 |
| G-10 | 冷启动直接停在非消息 tab，红点即准 |
| G-02 | 撤回后对端 ≤1s 变灰条；重进会话不复活 |
| G-09 | 引用块可点击跳转；原消息撤回后引用同步变「消息已撤回」 |
| G-04 | 双实例部署下限流与连接数上限仍按全局生效 |
| G-05 | 同会话并发发送不再串行等待聚合查询；height 无空洞无重复 |
| S-01 | 任一方开启后双方到期均不可见，且对象存储中的媒体已删 |
| G-13 | 断网 1 分钟内对端发的消息，恢复后 ≤3s 出现在已打开会话与列表，无重复 |
| G-14 | 清空后重启不复现、未读归零、对端不受影响 |
| G-15 | A 端标已读后，同账号 B 端红点 ≤1s 归零 |
| G-18 | 前后台切换后，图标角标 = tab 未读数 |

---

## 7. 测试约定

- **BE**：jest（`npx jest --roots src` 绕开 `.claude/worktrees/` 扫描）
- **FE**：`node --test test/*.test.js` 源码断言式契约测试，不是 jest/RTL
- 每一批**先补契约测试再实现**：跨仓事件名与错误码的对齐测试是这套栈唯一的防漂移手段
- 批次 1 建议先写 `test/chat-core-persistence.test.js`，定义「冷启动读本地 → REST 到达后
  按 height 对账」这条不变量，再实现

---

## 8. 二轮复核（2026-08-09）：查过且**排除**的疑似缺口

> 依据：对迁移前最后快照 `circle-im@6c20ad7c` 的 git 史全量扫描（46 个 SDK 方法调用 +
> 15 个事件监听的并集，与任何历史版本一致），逐项与新栈对照。**后人别再重查这些。**

| 疑似缺口 | 排除理由 |
|---|---|
| typing 正在输入 | 旧栈**从未用过**（发送 API 全历史 0 命中；仅把收到的 TypingMessage 过滤丢弃）。新栈 BE 全通、FE 有发送函数但零调用 + 无监听 —— 是半成品接线不是回归，处置见 §9 |
| 会话草稿 | 旧栈 `setConversationDraft` 0 命中，草稿一直是组件内 useState，两代行为相同 |
| 合并转发 | `createMergerMessage` 0 命中；单条转发两代都有，已对齐 |
| 表情回应 / 群已读回执 / 消息编辑 | 旧栈全部没用过 —— 是 G-07 的**增量能力**，不是回归 |
| 群禁言（单人） | 旧栈只渲染禁言系统提示，从未调 mute API；新栈 `muteAllAt` 随管理台停用走 —— 无回归 |
| 进群申请/验证 | 旧栈走 REST（`/circle/{id}/join`、circle-invitation），未用 OpenIM group application，链路未变 |
| 音视频通话 | 通话**从来不走 OpenIM**（独立 `/realtime` 裸 ws + REST + LiveKit）。来电离线无推送、无铃声、无 CallKit 是**存量产品缺口**，不是迁移回归，归 call 域另立项 |
| 拉黑 | 旧栈就走 REST（SDK 黑名单 0 命中）且 FE 无发送拦截；新栈 BE 双向拦截（建会话 + 发送事务内复查）比旧栈更严 |
| @ 提及 | 发送 + 推送穿透免打扰已对齐；旧栈渲染同为纯文本、`groupAtType`「有人@我」角标全仓 0 命中 —— 接收侧高亮/角标属增强（§9） |
| 单聊已读回执 | 旧 `onRecvC2CReadReceipt` ↔ 新 `chat:read`→`peerReadHeight`，已对齐 |
| 在线状态订阅 | 旧栈唯一消费方是单聊对端在线，新栈会话房广播覆盖该场景 —— S-03 排最后的判断正确 |
| 群内昵称 | 旧栈封装存在但**无任何 feature 调用方**，非用户可见能力，不追 |
| 推送点击跳会话 | push data 带 `conversationId`，FE `push-notification-route.ts:139` 已消费，链路通 |
| temp-chat-web | **已完成迁移**：PR #2 已合 main，`@openim/client-sdk` 出清、改连 `/chat-ws` + `/temp-chat/*`，CI 有 OpenIM license 闸门。无待办（注意本地 main 未 fetch，还停在旧版） |
| temp-chat（BE） | 完整落在 chat 栈上：同三表同网关同 height 同敏感词；访客 token 双闸 + 发送事务内复查在座 |
| 聊天媒体私有化 | **chat 侧 presign-on-read 已落地**（key 落库、写路径 strip URL、读时批签 1h 窗口）——`docs` 里「私有媒体 P0 chat 半未做」的旧结论在本分支已过时 |
| 敏感词 | 进程内 trie 已接进 `sendMessage`（含 temp-chat 访客路径），fail-open + 退避；数字码 73001 → `CHAT_SENSITIVE_WORD_BLOCKED` 完成换轨 |
| OpenIM webhook/回调 | 路由已全拆，无消费方残留（常量文件除外，见 §9） |
| 管理台群操作 | `AdminGroupOperationProcessor` 已改写本地表（muteAllAt/清座/解散），不再调 OpenIM admin API；管理台本就没有消息级审查能力，无回归 |

## 9. 顺带清理项（不立 G，逢批顺手做）

**FE（circle-im）**

- `chat-send-payloads.ts:55-75` `buildAtMessagePayload`：OpenIM 形状死代码（`atUserList`
  / `AtAllTag`），实际协议是 `client.ts` 的 `{mentions, atAll}` —— 删
- `system-notice-dedupe.ts` 读的 `systemNoticeKind` 等字段无人产出，
  `collapseDuplicateFriendAddedNotices` 已是 pass-through —— 删，或决定是否由 BE 系统
  消息补回旧栈的「你们已成为好友」提示条（旧栈本地插入 `friend_added`，新栈无产方）
- `use-app-settings-store.ts:22-23` `singleTyping`/`groupTyping` 死开关：typing 接线时
  一并处置 —— **接上**（发送已有节流函数、BE 已广播，差 dispatcher 监听 + UI）**或删掉**
- `file` 消息类型半开：BE `CLIENT_MESSAGE_TYPES` 收、FE 发不出也渲染不了（default 分支
  空气泡），`ChatHistoryFilesScreen` 永远空 —— 要么补全（发送 + 气泡 + 搜索），要么 BE
  摘掉该类型 + FE 藏入口；同理清掉 `ChatHistoryMediaScreen.tsx:146` 的 video 死分支
- 免打扰不抑制端内横幅：`dispatcher.ts:220-245` 补一条 `conversation.muted` 判定
- 会话列表项无「发送失败」标记（`mappers.ts:123-136`）：outbox 落地时顺带
- 收到未知 type 渲染成空文本气泡（`message-mappers.ts:365-373`）：给个「[暂不支持的消息
  类型]」占位，为将来新增类型的旧版本兼容兜底

**BE（circle_be）**

- `sensitive-word.constants.ts:7-86`：整个 OpenIM before-send 回调契约（73001、
  `OpenimBeforeSendCallbackBody` 等）已无消费方 —— 删，`SensitiveWord` 表的 schema
  注释同步改
- `auth-tokens.dto.ts:13-16` 可选 `imToken` 字段 + `auth.service.ts:488,501-502,71-75`
  孤儿注释 —— 删
- `StorageAuditService`：把 `chat/` 排除的注释理由（「URL 固化在 OpenIM Mongo」）已失真，
  key 现在就在 `ChatMessage.content` —— `chat/` 前缀纳入盘点，并补孤儿对象策略
  （presign 后未发送的对象目前无人回收）
- admin 域 `entityType: 'OpenIMGroup'` 文案与 Swagger 描述里的 OpenIM 字样 —— 随手改
- 敏感词只检 `content['text']`：卡片标题 / location 描述 / 文件名不过滤 —— 记录现状，
  扩不扩由产品定
- `chat-circle-sync.service.ts:43` `retryQueue` 是进程内状态：单实例无碍（cron 兜底），
  多实例批次（G-04）时记得它的语义是 best-effort
