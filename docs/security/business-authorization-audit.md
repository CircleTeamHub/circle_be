# 业务授权本地核查与回归记录

2026-10-16。仅本地；服务器已到期，未部署或进行线上验收。此记录区分路由盘点、人工核查和执行过的测试，不把测试通过当成不存在任何漏洞的证明。

## 核查范围

`http-route-inventory.json` 记录 321 个 HTTP handler（不含 WebSocket 事件、框架内置探针/Swagger）。逐类检查认证入口、调用者身份来源、对象 owner/member/role 约束、匿名例外；深入复核下表的业务路径。HTTP 越权矩阵使用真实 Controller、JWT Guard、DTO 校验和业务 Service，仅替换数据库/外部 I/O；它覆盖关键攻击路径，不等于 321 个 handler 都做了真实数据库 HTTP 测试。

| 领域 | 已检查的授权边界 | 结果 / 回归依据 |
|---|---|---|
| 笔记、分组、草稿、共享、导出、媒体引用 | 私有读与编辑绑定 ownerID；公开/分享读取按分享策略；收藏来源必须是本人当前可见的同一张笔记卡片 | 修复来源消息快照越权；`note.service.spec.ts`、`note-review-regressions.spec.ts`、HTTP 矩阵 |
| 聊天历史、清空/删除/撤回、转发、收藏、卡片 | 当前成员资格、清空水位、删除/撤回、焚毁过期、消息与会话一致；修改动作限制发送者/管理权限 | 修复 guest 卡片读取缺少清空/过期检查；`chat.service.spec.ts` 等 |
| 群成员管理、角色、入群/邀请、圈子修改 | 群主/管理员/普通成员分权，不能自提权；邀请和申请需要接受/批准；关键写事务内复核 | `group.service.spec.ts`、`group-admission.service.spec.ts`、相关 HTTP / integration 测试及新 HTTP 矩阵 |
| 会话分类、用户收藏、通知 | ownerID / userID / toUserID 均来自 JWT；任意会话分类 ID 不会授予聊天读取权 | HTTP 矩阵验证跨账号修改/删除不写库；通知对无权对象按原有合同返回成功 no-op |
| 钱包、赠送、靓号和扩容购买 | 付款身份来自 JWT；余额条件更新、额度、正整数金额、服务端报价、用户范围内的幂等及请求指纹 | HTTP 矩阵含伪造付款人/钱包 owner、负数/小数金额、他人幂等键；原有 coin / fancy-number / group-expansion 测试 |
| 通话 | 历史 INVITED/JOINED 不能永久授予媒体入会权；重新签发前检查现有好友/拉黑/隐私、圈子状态/席位、独立群席位、临时房期限 | 修复 accept / join-token / 重复创建的凭证签发路径；`call.service.spec.ts`、`call-direct.spec.ts` |
| 临时聊天 | 访客凭证绑定 guest / room / conversation；原子占座；结束只允许房主；笔记卡片限定房主发送且当前可见 | `temp-chat`、guest guard 和 chat 卡片回归；匿名例外清单要求 guest 路由挂专用 Guard |
| 好友、标签、拉黑、隐私、动态、点赞 | 操作者来自 JWT；请求参与者、标签 owner、动态可见性/作者、评论所属动态和点赞发起者约束 | 原有 friend / privacy / trace / like 业务测试；本轮未发现新的可复现对象越权 |
| 上传、聊天媒体和二维码 | presign 写入自身命名空间；私有聊天读取/转存先走消息权限；二维码 USER 为本人、群/圈子需成员及邀请策略 | upload / chat-media / qr 测试；公开头像等目录按既有产品合同处理 |
| 登录设备 / 会话 | 设备查询和撤销绑定 userID；批准者必须受信任；challenge 绑定所属账号与发起设备；撤销与 token issuance 既有账号锁 | device-trust / auth / refresh-token 测试 |
| 管理台（账号/社区/内容/IM/运营/商城/充值/审核等） | ADMIN audience + 当前 DB 角色/状态 + permission；缺少权限配置拒绝；权限写入在事务中重查操作者并检查目标版本 | 18 个管理 Controller 均使用 AdminPermissionGuard；新增 `admin-authorization.http.spec.ts` 验证横向/纵向边界及事务中降权；`admin-access-contract.spec.ts` 阻止新管理接口漏挂权限守卫/权限声明 |
| 头像框、会员目录、商店、图标、地理、客服配置、推荐 | 用户资产/推荐绑定当前用户；目录/地理/公开客服配置为设计允许的读取；管理写操作走管理台权限 | 对应服务/Controller 现有测试；未将合法目录读取误改为资源 owner-only |

## 修复详情

1. **收藏笔记泄漏来源聊天信息。** 原来按请求给出的消息 ID 读取 sender/group 快照，没有验证请求人能看到该消息；公开笔记不能成为读取别人私聊快照的入口。现在复用 `ChatService.requireVisibleMessage`，校验 conversation、`note-card` 类型和 `content.noteId`，旧数据 fallback 的发送者和群 ID 也绑定到已授权的真实记录。
2. **访客卡片读取绕过消息清空/过期。** `getNoteCardNoteId` 原先只做席位、deleted/revoked 条件；现在使用相同消息可见性检查，保留房主发送者校验。
3. **历史通话参与记录可换取新凭证。** 在 accept 前与统一 mintToken 入口复查现有权限。Circle UUID、旧 groupID 和 canonical ChatConversation 三种路径统一处理；旧 ChatMember 不得绕过 CircleMember，TEMP 需要实际未结束/未过期房间。

这批改动不涉及表结构迁移。ChatService 已由现有 NoteModule 导入；NoteService 增加必需的依赖注入，启动/构建时不能静默绕过校验。

## 本地验证

- 最终完整后端 Jest：316 suites / 4190 tests 通过，原有 3 suites / 15 tests 跳过；随后新增的管理接口权限契约检查单独运行 1 suite / 1 test 通过。
- 两组真实 HTTP 回归：35 tests 通过，涵盖笔记、收藏、会话分组、通知、钱包、群角色和管理台权限。
- 后端 `npm run build` 通过；改动文件 eslint 零错误（14 条现有代码警告），`git diff --check` 通过。通话专项 8 suites / 102 tests 通过。运行中的本地后端 `/readyz` 返回 200，database / redis / objectStore 正常。

## 验证边界

- 尚未做线上渗透测试、真实多机压力测试或腾讯云端口复核；旧服务器不可用。网关并发预算仍按进程计数，不能据此宣称具有上游带宽抗 DDoS 能力。
- HTTP 矩阵替换了 Prisma 持久层；并发/事务数据库行为需依赖既有集成测试及恢复部署后的验收，不能用 mock 模拟结果替代真实数据库保证。
- 本轮通话修复覆盖**新 LiveKit 凭证签发**。已签发的媒体 JWT 与正在进行的媒体连接不受 HTTP Guard 直接控制；即时驱逐、旧 JWT 重连策略及事件时序仍需 LiveKit 侧联调验证，不能宣称本修复具有即时媒体撤销能力。
