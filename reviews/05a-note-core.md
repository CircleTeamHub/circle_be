# Phase 4a — Note Core Review

> 范围:`src/note/` 的**写路径与分组生命周期**:
> - `note.module.ts`、`note.controller.ts`(create/update/pin/available/delete + group 路由)
> - `note.service.ts`:`createNote` / `updateNote` / `setPinned` / `setAvailable` / `deleteNote` / `listGroups` / `createGroup` / `updateGroup` / `deleteGroup` / `reorderGroups`,以及内容/媒体派生 helper(`deriveNoteContent` / `extractBlockText` / `deriveMediaFromBlocks` / `assertMediaOwnership` / `buildMediaStats` / `requireOwned*`)
> - `note.dto.ts` 的 create/update/group DTO
> - `prisma/schema.prisma`:`Note` / `NoteMedia` / `NoteGroup` / `NoteGroupMembership`
>
> `listNotes`(搜索/过滤/分页)、媒体元数据信任、`mapSummary/mapDetail`、spec 测试在 **Phase 4b**。
> 颗粒度:逐文件逐行。

---

## 0. TL;DR — Top 排序

| # | 严重度 | 位置 | 描述 |
|---|---|---|---|
| 1 | **MED** | [note.service.ts:310-336](src/note/note.service.ts:310) `deriveNoteContent` | 当 `contentJson` 非空时,`title` 取 `extractedText[0]`、`content` 取所有文本 join。**两者都绕过 DTO 的 `@MaxLength(120)` / `@MaxLength(20000)`** —— `contentJson` 里一个超长文本块会变成无上限的 `Note.title`(列无长度约束);join 后的全文同样无上限写入 `Note.content` |
| 2 | **MED** | [note.service.ts:687-727](src/note/note.service.ts:687) `createGroup` / [:729-780](src/note/note.service.ts:729) `updateGroup` | `NoteGroup` **无 `@@unique([ownerID, name])`**(schema 只有 `@@index([ownerID, deletedAt, sortOrder])`)。重名检测是 SELECT-then-INSERT 的 TOCTOU;`createGroup` 的 `count >= MAX_GROUPS_PER_USER` 检查同样 TOCTOU → 并发创建可造重名组、可越过 50 上限 |
| 3 | **MED** | [note.service.ts:557-620](src/note/note.service.ts:557) `updateNote` | 每次 PATCH 都 `noteMedia.deleteMany` + 重新 `createMany`(全部分配新 UUID),**即便媒体没变**。后果:① 旧 `NoteMedia` 行对应的 S3 对象无人清理 → 存储泄漏;② media id 每次 PATCH 翻新,任何外部引用失效 |
| 4 | **MED** | [note.service.ts:652-659](src/note/note.service.ts:652) `deleteNote` | 软删只把 `Note.status` 置 DELETED,**`NoteMedia` 行与其 S3 对象永久遗留**;被删笔记的媒体行在库里永远是死重 |
| 5 | **MED** | [note.dto.ts:114-118](src/note/dto/note.dto.ts:114) `CreateNoteDto.contentJson` | 仅 `@IsArray` + `@ArrayMaxSize(500)`,**元素类型 `Record<string, unknown>` 完全不校验/不消毒**,原样存入 `contentJson Json?`。配合 #1 的派生逻辑,内容侧输入面基本无约束 |
| 6 | LOW | [note.controller.ts](src/note/note.controller.ts) | 11 处 `@Req() req: any` —— 应用 Phase 1 的 `RequestWithUser` |
| 7 | LOW | [schema.prisma Note.groupID](prisma/schema.prisma#L362) | `Note.groupID` 是**死字段**:`createNote`/`updateNote` 永远写 `groupID: null`,真正的分组关系走 m2m `NoteGroupMembership`。`groupID` + `@@index([groupID])` 是历史遗留 |
| 8 | LOW | [note.service.ts:652-659](src/note/note.service.ts:652) `deleteNote` | `note.update` 的 where 只有 `{ id }`,与 `setPinned`/`setAvailable` 特意加的 `{ id, ownerID, status }` TOCTOU 守卫不一致 |
| 9 | LOW | [note.service.ts:713-718](src/note/note.service.ts:713) `createGroup` | `sortOrder: groupCount` 在并发创建下会撞值(无唯一约束,不致错,只是排序乱) |
| 10 | LOW | [note.service.ts:823-853](src/note/note.service.ts:823) `reorderGroups` | count → requireOwnedGroups → transaction 之间有 TOCTOU 小窗口(并发增删组时 reorder 可能基于过期集合) |

共 **10 项**:HIGH 0、MED 5、LOW 5。

---

## 1. File: `src/note/note.module.ts` (9 lines)
标准 module,无 `exports`(无人依赖 NoteService)。**OK**。

---

## 2. File: `src/note/note.controller.ts` (168 lines)

### Walkthrough
- L39-42 类装饰:`@ApiTags` + `@ApiBearerAuth` + **`@UseGuards(JwtGuard)`(类级)** + `@Controller('note')` ✓
- L46-54 `GET /note` listNotes — `@Query() ListNotesQueryDto`(4b 详查)
- L56-64 `POST /note` createNote — `@Body() CreateNoteDto`;无 `@HttpCode` → 201 ✓
- L66-75 `PATCH /note/:id` updateNote — `ParseUUIDPipe` ✓
- L77-86 `PATCH /note/:id/pin` — `SetPinnedDto`
- L88-97 `PATCH /note/:id/available` — `SetNoteAvailableDto`
- L99-108 `DELETE /note/:id` — `NO_CONTENT` ✓
- L110-115 `GET /note/group` — **声明在 `GET /note/:id`(L117)之前** ✓ 字面路由优先,`/note/group` 不会被 `:id` 吞
- L117-125 `GET /note/:id` getNote
- L127-135 `POST /note/group` createGroup
- L137-145 `PATCH /note/group/order` — **声明在 `PATCH /note/group/:id`(L147)之前** ✓
- L147-156 `PATCH /note/group/:id` updateGroup
- L158-167 `DELETE /note/group/:id` deleteGroup

### 路由顺序核对(Verified OK)
- `GET /note/group` 先于 `GET /note/:id` ✓
- `PATCH /note/group/order` 先于 `PATCH /note/group/:id` ✓
- `PATCH /note/:id`(1 段)与 `PATCH /note/group/:id`(2 段)段数不同,无碰撞 ✓

### Findings
- [LOW-6] 11 处 `@Req() req: any`

### Verified OK
- 类级 JwtGuard
- 所有路径参数 `ParseUUIDPipe`
- 字面路由声明顺序正确
- 全部走 `@Body() dto: XxxDto` 强 DTO

---

## 3. File: `src/note/dto/note.dto.ts`(create/update/group 部分)

### Walkthrough
- **L33-44 `UniqueMediaSortOrderConstraint`** —— 自定义校验器,确保 media 的 `sortOrder` 不重复 ✓ 好(`NoteMedia @@unique([noteID, sortOrder])` 的前置防御)
- **L46-99 `CreateNoteMediaDto`** —— type/objectKey(≤255)/url(`@IsUrl`)/可选元数据/sortOrder。媒体元数据信任问题留 4b
- **L101-144 `CreateNoteDto`**
  - title `@IsNotEmpty @MaxLength(120)` ✓ —— 但见 MED-1,`contentJson` 路径会绕过它
  - content `@MaxLength(20000)` ✓ —— 同样被绕过
  - **L114-118 contentJson `@IsArray @ArrayMaxSize(500)`** —— 元素 `Record<string, unknown>` 不递归校验(MED-5)
  - groupIds `@IsUUID each` + `@ArrayMaxSize(50)` ✓
  - status `@IsEnum(NOTE_WRITABLE_STATUS)` —— **排除了 DELETED** ✓ 客户端不能直接把 status 设成 DELETED
  - media `@ValidateNested @Type @ArrayMaxSize(50)` + 唯一 sortOrder 校验 ✓
- **L146 `UpdateNoteDto extends CreateNoteDto`** —— update 复用 create 的全部约束;意味着 update 也是"全量替换"语义(media/groupIds 不传即清空)
- **L191-205 `CreateNoteGroupDto` / `UpdateNoteGroupDto`** —— name `@IsNotEmpty @MaxLength(30)` ✓
- **L207-213 `ReorderNoteGroupsDto`** —— groupIds `@IsUUID each @ArrayMaxSize(50)` ✓

### Findings
- [MED-5] L114-118 contentJson 元素无校验

### Verified OK
- 自定义 sortOrder 唯一性校验器
- status DTO 限定为 ACTIVE/UNLISTED(无法直接设 DELETED)
- media / groupIds / contentJson 都有 `@ArrayMaxSize`
- group name 有长度限制

---

## 4. File: `src/note/note.service.ts` — Core 段

### 4.1 helper:`requireOwnedGroups` L141-160 / `requireOwnedGroup` L162-176 / `requireOwnedNote` L178-193
- 全部按 `ownerID` 范围查询 + `deletedAt: null` / `status != DELETED` ✓
- `requireOwnedGroups` 用 `groups.length !== groupIds.length` 判定"有不属于自己的" ✓

### 4.2 helper:`assertMediaOwnership` L195-206
- `prefix = notes/${ownerID}/`,任一 objectKey 不以此开头 → 400 ✓
- **比 user 模块的 `assertUrlsAreSafe`(用 `startsWith` 比 host)更安全** —— 这里 prefix 含 ownerID,跨用户引用别人媒体被挡死

### 4.3 helper:`extractBlockText` L224-257 / `deriveMediaFromBlocks` L259-308
- 两者都有 `depth > 10` 递归深度守卫 ✓ —— 防恶意深嵌套 contentJson 把遍历栈打爆
- `extractBlockText` 抽 text / link 文本

### 4.4 helper:`deriveNoteContent` L310-336 — 🟠 MED-1
- `blocks = Array.isArray(contentJson) ? contentJson : []`
- L325-328 `derivedTitle = blocks.length > 0 ? (extractedText[0] ?? input.title) : input.title`
  - 🟠 **当 contentJson 有内容,title 来自 `extractedText[0]`** —— 这个文本片段可达 20000+ 字符,`Note.title` 列无长度约束 → 超长 title 入库
- L321-324 `derivedContent = blocks.length>0 ? extractedText.join(' ') : input.content` —— 同样绕过 `@MaxLength(20000)`
- `derivedMedia`:优先 `input.media`,空则从 blocks 派生

### 4.5 `createNote` L403-477
- L407 dedupe groupIds ✓
- L408 `requireOwnedGroups` ✓
- L410 `deriveNoteContent`、L411 `assertMediaOwnership` ✓
- L413-419 media 按 sortOrder 排序 + 分配新 UUID
- L421 `coverMediaID = media[0]?.id`
- L424-474 **事务**:create note → createMany media → createMany membership → update note(写 coverMediaID)
  - create-then-update 两次写 note —— 因 `coverMediaID` 引用 `NoteMedia.id`,必须先建 media,无法在 create 时一步到位 ✓ 合理
  - `groupID: null` 恒定写死(LOW-7,死字段)
- 全程在 `$transaction` 内 ✓

### 4.6 `updateNote` L536-623 — 🟠 MED-3
- L541-545 dedupe / requireOwnedGroups / derive / assertMediaOwnership
- L557-620 事务:
  - **L560-566 在事务内重新校验 ownership(TOCTOU 守卫)** ✓ —— 注释明确说明防"并发删除被 update 复活"
  - **L568-574 `noteMedia.deleteMany` + `noteGroupMembership.deleteMany`** —— 全清
  - L576-602 重建 media(新 UUID)+ membership
  - L604-619 update note;`status: input.status ?? existing.status` ✓ 保留原状态(注释说明:omit status 不应把 UNLISTED 静默升 ACTIVE)
- 🟠 **MED-3**:media 全删全建 —— 旧 NoteMedia 对应的 S3 对象无清理逻辑 → 每次编辑笔记泄漏一批 S3 对象;media id 每次翻新

### 4.7 `setPinned` L625-637 / `setAvailable` L639-650
- `requireOwnedNote` → `note.update({ where: { id, ownerID, status: { not: DELETED } }, ... })`
- **update where 带 `ownerID + status`** —— 注释明确是 TOCTOU 加固 ✓ 好

### 4.8 `deleteNote` L652-659 — 🟡 LOW-8
- `requireOwnedNote` → `note.update({ where: { id }, data: { status: DELETED } })`
- where 只有 `{ id }`,与 setPinned/setAvailable 的加固不一致(LOW-8)
- 软删,媒体不清(MED-4)

### 4.9 `listGroups` L661-685
- findMany `ownerID + deletedAt: null`,`_count.memberships`(只数非 DELETED 笔记)✓
- 无分页,但 `MAX_GROUPS_PER_USER=50` 兜底 ✓

### 4.10 `createGroup` L687-727 — 🟠 MED-2
- L691 trim name
- L693-701 `Promise.all([findFirst 重名, count])` —— 事务**外**的并行只读,OK
- L703-711 重名 → 409;count ≥ 50 → 400
- L713-719 create,`sortOrder: groupCount`(LOW-9 并发撞值)
- 🟠 **MED-2**:重名检测与上限检查都是 TOCTOU,`NoteGroup` 无 `@@unique([ownerID, name])` 兜底

### 4.11 `updateGroup` L729-780
- findFirst owned + deletedAt null → 404
- L749-757 仅当名字变化才查重名冲突(TOCTOU,同 MED-2)
- update + 返回 `mapGroup`

### 4.12 `deleteGroup` L782-821
- findFirst owned → 404
- 事务:deleteMany membership → soft-delete(deletedAt)→ **raw SQL 用 `ROW_NUMBER()` 重排 sortOrder**
  - L815 `WHERE "ownerID" = ${ownerID}` —— Prisma tagged template **参数化** ✓ 无注入
  - 用单条 `UPDATE…FROM` 而非 N 次 update ✓ 高效

### 4.13 `reorderGroups` L823-853
- L831-838 **要求传入全部 group**(count 比对)✓ —— 防部分重排导致 sortOrder 碰撞,设计好
- L841 `requireOwnedGroups` ✓
- L843-850 `$transaction([...updates])` 批量 ✓
- LOW-10:count→ownership→txn 间小 TOCTOU 窗口

### Findings
- [MED-1] deriveNoteContent 派生 title/content 绕过长度限制
- [MED-2] createGroup/updateGroup 重名 TOCTOU + count TOCTOU
- [MED-3] updateNote 全删全建 media → S3 孤儿 + id 翻新
- [MED-4] deleteNote 软删不清媒体
- [LOW-7] Note.groupID 死字段
- [LOW-8] deleteNote update where 不一致
- [LOW-9] createGroup sortOrder 并发撞值
- [LOW-10] reorderGroups TOCTOU 小窗口

### Verified OK ✅
- 全部 note/group 操作按 `ownerID` 范围 —— 无跨用户访问
- `updateNote` 在事务内重新校验 ownership(TOCTOU 守卫)
- `setPinned`/`setAvailable` update where 带 `ownerID + status` 加固
- `assertMediaOwnership` 用含 ownerID 的 prefix —— 跨用户引用媒体被挡
- `extractBlockText`/`deriveMediaFromBlocks` 有 depth>10 守卫防深嵌套攻击
- `deleteGroup` 重排用参数化 raw SQL —— 无注入
- `reorderGroups` 强制全量,防部分重排碰撞
- PATCH 省略 status 时保留原值 —— 不会把 UNLISTED 静默升 ACTIVE
- `status` DTO 限定 ACTIVE/UNLISTED —— 客户端无法直接设 DELETED
- `MAX_GROUPS_PER_USER` 上限存在
- DTO 自定义校验器保证 media sortOrder 唯一

---

## 5. 修复建议(只列 MED,完整放 99-summary)

| ID | 建议补丁 |
|---|---|
| #1 | `deriveNoteContent`:对 `derivedTitle` 截断到 120、`derivedContent` 截断到 20000(与 DTO 一致),或在派生后再跑一次长度校验 |
| #2 | `NoteGroup` 加 `@@unique([ownerID, name])`(migration);service 重名检测改 `catch P2002`;count 上限的 TOCTOU 可接受(超 1-2 个无害)或用 advisory lock |
| #3 | `updateNote`:diff 媒体而非全删全建 —— 比对 objectKey,只增删变化的;被删的 NoteMedia 收集 objectKey 交给 S3 清理(异步 job / 出站删除) |
| #4 | `deleteNote`:软删时把该 note 的 media objectKey 入一个"待清理"队列;或定期 GC 扫描 DELETED note 的 NoteMedia |
| #5 | `contentJson` 加结构校验:限制单块大小、限制嵌套深度(DTO 层用自定义校验器,与 service 的 depth>10 守卫呼应);或对元素做白名单字段过滤 |

---

## 6. Phase 4a 总评

- **所有权与并发处理是这个模块的亮点**:全程 `ownerID` 范围、`updateNote` 在事务内二次校验 ownership、`setPinned`/`setAvailable` 的 update where 加固、`assertMediaOwnership` 用带 ownerID 的 prefix、`reorderGroups` 强制全量 —— 这套 TOCTOU 意识比 friend 模块强很多
- **薄弱面集中在"内容/媒体的生命周期"**:
  - `contentJson` 派生的 title/content 绕过 DTO 长度校验(#1/#5)
  - `updateNote`/`deleteNote` 留下 S3 孤儿对象,无清理路径(#3/#4)
  - `NoteGroup` 缺唯一约束,重名靠 TOCTOU 检测(#2)
- **无 HIGH** —— 没有跨用户越权、没有金钱、没有未鉴权入口;笔记完全是 owner-private(本模块内无公开/好友可见路径,可见性 flag 留给 circle-plaza 用)

下一步:Phase 4b — Note media / list / 计数 / search + spec。
