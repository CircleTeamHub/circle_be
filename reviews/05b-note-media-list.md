# Phase 4b — Note Media / List / Search Review

> 范围:`src/note/` 的**读路径与媒体信任**:
> - `note.service.ts`:`listNotes`(搜索/过滤/分页)、`getNote`、`mapSummary` / `mapDetail` / `mapGroup`
> - `note.dto.ts`:`CreateNoteMediaDto`、`ListNotesQueryDto`、`NoteMediaDto` / `NoteSummaryDto` / `NoteDetailDto`
> - 媒体元数据信任边界(client → `NoteMedia`)
> - `note.service.spec.ts` / `note.dto.spec.ts` 覆盖评估
>
> 写路径与分组在 **Phase 4a**(`05a-note-core.md`)。
> 颗粒度:逐文件逐行。

---

## 0. TL;DR — Top 排序

| # | 严重度 | 位置 | 描述 |
|---|---|---|---|
| 1 | **MED**(经 circle-plaza 暴露后可升 HIGH) | [note.dto.ts:56-58,90-93](src/note/dto/note.dto.ts:56) `CreateNoteMediaDto.url` / `posterUrl` | 媒体的 `url` / `posterUrl` 是**客户端完全可控的任意 URL**(`@IsUrl({require_tld:false})`,无 origin 约束)。`assertMediaOwnership` 只校验 `objectKey` 前缀,**不校验 `url`**。客户端可造一条 note:`objectKey` 合法(`notes/{me}/x.jpg`)但 `url` 指向 `https://evil.com/track.gif`。note 模块内只能自伤,但 **circle-plaza 会把 note 暴露给其他圈成员** → 渲染他人 note 时加载攻击者 URL = 追踪 / 钓鱼 / 挂马。user 模块的头像 URL 有 `assertUrlsAreSafe`,note 媒体没有,不一致 |
| 2 | **MED** | [note.service.ts createNote/updateNote](src/note/note.service.ts) + `CreateNoteMediaDto` | 媒体元数据(`type` / `mimeType` / `size` / `width` / `height` / `durationMs`)**全部客户端可信**,服务端不向 S3 核实对象存在性、不核实 type 与真实文件一致。客户端可把视频标成 `IMAGE`(计数错乱)、报任意尺寸、引用根本不存在的 objectKey(坏图) |
| 3 | **MED** | [note.service.ts:487-526](src/note/note.service.ts:487) `listNotes` search | `search` 用 `title/content contains` + `mode: insensitive` —— Prisma 参数化无注入,但 `contains` 是子串匹配,`title`/`content` 列无 trigram/全文索引 → 大数据量下顺序扫(单用户 note 量小,影响有限) |
| 4 | LOW | [note.service.ts:479-529](src/note/note.service.ts:479) `listNotes` | 返回裸 `NoteSummaryDto[]`,无 `total` / `hasMore` 分页元数据 —— 客户端翻页只能盲翻 |
| 5 | LOW | [note.dto.ts:51-54](src/note/dto/note.dto.ts:51) `CreateNoteMediaDto.objectKey` | `@IsString @MaxLength(255)`,无字符集 / `..` 守卫;`assertMediaOwnership` 的 `startsWith('notes/{ownerID}/')` 对 `notes/{ownerID}/../../x` 仍通过(S3 key 是扁平字符串,`..` 不会真穿越,但属脏数据) |
| 6 | LOW | `note.service.spec.ts` / `note.dto.spec.ts` | 覆盖缺口:`listNotes` 的 groupId 过滤 / search / 分页参数;`assertMediaOwnership` 拒绝跨用户 objectKey;`updateNote` 事务内 ownership 重校验;媒体 url origin(本来就没校验,所以也没测) |

共 **6 项**:HIGH 0、MED 3、LOW 3。

---

## 1. File: `src/note/note.service.ts` — Read 段

### 1.1 `listNotes` L479-529
- L483-485 `if (query.groupId) requireOwnedGroup(...)` —— groupId 过滤前先验组所有权 ✓
- L487-526 `note.findMany`:
  - `ownerID` 范围 ✓
  - `status: query.status ?? { not: 'DELETED' }` —— 默认排除 DELETED ✓;若客户端传 `status`,DTO `ListNotesQueryDto.status` 用 `NOTE_STATUS`(含 DELETED)—— 注意:**客户端可显式 `?status=DELETED` 查自己的已删笔记**(都是自己的,无越权,产品上是否允许待确认)
  - groupId 过滤:`groupMemberships.some({ groupID, group.deletedAt: null })` ✓
  - search:`OR: [title contains, content contains]` `mode: insensitive`(MED-3)
  - `orderBy: [{pinned: desc}, {updatedAt: desc}]` ✓
  - **分页存在**:`take: limit ?? 50`、`skip`;DTO `limit @Max(200)`、`page @Min(1)` ✓ —— 比 friend 列表强
- 返回裸数组(LOW-4)

### 1.2 `getNote` L531-534
- `requireOwnedNote`(owner 范围 + status≠DELETED)→ `mapDetail` ✓

### 1.3 `mapSummary` L338-371 / `mapDetail` L373-392 / `mapGroup` L394-401
- `mapSummary`:cover = `coverMedia ?? media[0] ?? null` ✓
- `mapDetail`:spread summary + content + `contentJson`(`Array.isArray` 守卫)+ media 列表
- 全是 owner 自己的数据,无 PII / 越权问题

### Findings
- [MED-3] L487-526 search 顺序扫
- [LOW-4] L479-529 无分页元数据
- [观察] `?status=DELETED` 可查自己的已删笔记

### Verified OK
- `listNotes` / `getNote` 全程 `ownerID` 范围
- groupId 过滤前验组所有权
- 默认排除 DELETED
- **有分页**(take/skip + DTO `@Max(200)`)
- search 经 Prisma 参数化,无注入
- `mapDetail` 对 `contentJson` 做 `Array.isArray` 防御

---

## 2. File: `src/note/dto/note.dto.ts` — Media / List DTO

### 2.1 `CreateNoteMediaDto` L46-99 — 🟠 MED-1 / MED-2 / LOW-5
- `type` `@IsEnum(NOTE_MEDIA_TYPE)` ✓ —— 但只校验"是 IMAGE/VIDEO 之一",不校验与真实文件一致(MED-2)
- `objectKey` `@IsString @MaxLength(255)` —— 无 `..` / 字符集守卫(LOW-5)
- **`url` `@IsUrl({require_tld:false})`** —— 🟠 **MED-1**:接受任意 URL,无 origin 约束
- `mimeType` / `size` / `width` / `height` / `durationMs` —— 全可选,客户端给什么是什么(MED-2)
- `posterUrl` `@IsUrl({require_tld:false})` —— 同 MED-1
- `sortOrder` `@IsInt @Min(0)` + DTO 级 `UniqueMediaSortOrderConstraint` ✓

### 2.2 `ListNotesQueryDto` L160-189
- `status @IsEnum(NOTE_STATUS)` —— 含 DELETED(见上方观察)
- `groupId @IsUUID`、`search @MaxLength(100)` ✓
- `page @Min(1)`、`limit @Min(1) @Max(200)` ✓ —— 分页边界完整

### 2.3 响应 DTO `NoteMediaDto` / `NoteSummaryDto` / `NoteDetailDto` L222-262
- `NoteMediaDto` 暴露 `objectKey` —— owner 看自己的 objectKey,无泄露
- 字段与 service 映射一致 ✓

### Findings
- [MED-1] url / posterUrl 无 origin 约束
- [MED-2] 媒体元数据全客户端可信
- [LOW-5] objectKey 无 `..` / 字符集守卫

### Verified OK
- `type` 枚举校验
- `sortOrder` DTO 级唯一性校验
- 列表分页边界(`@Min` / `@Max`)完整
- 响应 DTO 无 PII

---

## 3. 测试覆盖评估

### `note.service.spec.ts`(17 + 1 = 18 个测试)
覆盖到:create(普通 / block 派生)、listNotes(owner summary)、getNote(owner / 越权 404)、updateNote(替换媒体 + 重算计数)、pin / available / delete、groups(create/list/rename/conflict/delete/reorder)、4a 新增的截断测试

**缺口(LOW-6)**:
- `listNotes` 带 `groupId` 过滤 / 带 `search` / 带 `page+limit` 的行为
- `assertMediaOwnership` 拒绝 `objectKey` 不属于自己 → `BadRequestException`
- `updateNote` 事务内 ownership 重校验(并发删除场景)
- `requireOwnedGroup` 在 `listNotes(groupId)` 不属于自己时 404

### `note.dto.spec.ts`(7 个测试)
覆盖到:dup sortOrder、超长 title、DELETED status 被拒、contentJson 数组、空 title、groupIds 校验

**缺口**:
- media `url` 为非法 / 外站(本来就没校验逻辑,补了校验才需要测)
- `media` / `contentJson` 超 `@ArrayMaxSize` 被拒
- `CreateNoteMediaDto` 各可选字段的边界

---

## 4. 修复建议(只列 MED,完整放 99-summary)

| ID | 建议补丁 |
|---|---|
| #1 | `note.service` 增加 `assertMediaUrlsAreSafe`:校验 `url` / `posterUrl` 以 `MINIO_PUBLIC_URL` 为前缀(对齐 user 模块的 `assertUrlsAreSafe`),非本应用存储的 URL → 400。注入 `ConfigService` 读 `MINIO_PUBLIC_URL` |
| #2 | 中期:presign 时记录已签发的 objectKey + 真实 content-type / size,createNote/updateNote 时用服务端记录核对客户端声明,而非全盘信任。短期至少把 `url` 锁到自有 origin(#1)就能消除最大风险面 |
| #3 | `search` 若数据量增长,给 `Note.title` / `content` 加 `pg_trgm` GIN 索引;当前规模可暂缓 |

---

## 5. Phase 4b 总评

- **读路径本身干净**:`listNotes` / `getNote` 全程 owner 范围、有真正的分页(take/skip + DTO `@Max(200)`)、groupId 过滤前验组所有权、search 经 Prisma 参数化 —— 比 friend 模块的列表(无分页)成熟
- **真正的弱点是"媒体信任边界"**:
  - `objectKey` 被 `assertMediaOwnership` 锁到 `notes/{ownerID}/`,但**真正会被渲染的 `url` / `posterUrl` 完全没校验** —— 这是个被忽视的不对称。在 note 模块内只是自伤,一旦 circle-plaza 把 note 推给其他用户,就是对他人的追踪 / 钓鱼面
  - 所有媒体元数据(type / size / 尺寸 / mime)客户端可信,服务端不向 S3 核实
- **无 HIGH(限于 note 模块自身)** —— 但 #1 的最终严重度取决于 Phase 5 circle-plaza 如何暴露 note;review circle-plaza 时需回头确认这条链路

下一步:Phase 5 — Circle / Invitation / Plaza。
