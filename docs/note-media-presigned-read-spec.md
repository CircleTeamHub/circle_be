# 笔记媒体 Presign-on-Read（私有媒体 P0 修复规格）

> 状态：**已实现**（Step 1-7 全部完成，本分支）。后端全量测试通过（1114 passed / 0 fail）、typecheck + lint 干净。
> 客户端显示对 presign-on-read 透明，无需改（Step 8）。本文档保留作为设计记录 + reviewer 蓝图。
>
> 实现要点与规格一致，唯一微调：`objectKeyFromPublicUrl` 放在 UploadService（规格建议）；presign map 的 key
> 用 base url（而非 objectKey），让读路径 map 函数只需 `map.get(url) ?? url`、无需在读路径反推 key。

## 问题（P0）

MinIO bucket policy 给 `notes/*` 开了 `Principal:'*'` + `s3:GetObject`（`upload.service.ts` `buildPublicReadBucketPolicy`，每次 boot 无条件应用）。含义：

- 笔记有隐私开关 `NoteService.setAvailable(available:false)`。设私有后 **API 不返回该笔记**，但其媒体文件 `notes/<owner>/…` **仍可凭 object key 匿名下载**。
- key 是 `folder/userId/uuid.ext`（`upload.service.ts:181` 附近），含 v4 UUID，**不可枚举**、桶也不给 ListBucket。所以真实风险是「已知 URL 泄露后永久有效 / 设私有=撤回失效」，不是「遍历扫描」。但只要产品对用户承诺了「私有笔记」，这个开关目前名不副实，该修。

## 决策

- **notes：修**（presign-on-read，本规格）。
- **chat：接受现状，不修**。理由：聊天图 URL 是永久直链、**固化在 OpenIM 消息体**（`im/client.ts` `sendImageMessage` → `createImageMessageByURL` 的 sourcePicture/bigPicture/snapshotPicture），我们数据库里**没有任何 row 把 chat object key 关联到会话**（schema 无 Message 模型，聊天记录从 OpenIM HTTP API 读、不落库）。一旦从 policy 移除 `chat/*`，**所有历史聊天图立刻 404**且无法迁移。要真修需 schema 绑定 + 改消息格式 + 破坏历史（或 forward-only 架构），单独排期。`chat/*` 保留在 public policy。

## 关键事实（file:line，均对 `origin/main` 核实过）

- `prisma/schema.prisma:651` `NoteMedia` 存 `objectKey`(required) + `url`(required) + `posterUrl`(optional，视频封面，**无独立 objectKey**)。
- 读取路径（都是 **同步** 函数）：`mapSummary`(`note.service.ts:1096`，cover=`coverMedia.url`@1120)、`mapDetail`(:1138，`media[]` @1144-1156 返回 raw `url`+`objectKey`)、`mapMediaItemForSection`(:743)、`buildSectionsFromRow`(:993)。
- **`buildSectionsFromRow` 的坑（:1003-1011）**：当 `sections.media.items` 已是数组时**原样返回存储的 JSON items**（含写时冻结的 url），不是从 row 重新推导。这些冻结 url 也必须按 objectKey 重签。
- **`mapMediaItemForSection` 读写共用**：读路径经 `buildSectionsFromRow` 调用它；**写路径** `resolveSectionMediaItems`(:759，:770) 也调用它来生成存进 sections JSON 的 items。→ **写路径必须存持久的 objectKey+base url，只有读路径能 presign。**
- `available` gate 三处内联（无 helper）：`getNote`(:1548)、`collectNote`(:1668)、`createNoteExport`(:1781) 的 `OR:[{ownerID},{available:true}]`。（:1277/:1453 是搜索过滤不是 gate；`resolveShareLink`:1426 有注释说明它故意不复用此 gate。）
- **现成先例**：`createNoteExport`(:1832) 已经 `createPresignedGetUrl(item.objectKey, NOTE_EXPORT_TTL_SECONDS)` 然后 `return { url: download.url }`——presign-on-read 的模式已经在这个 service 里。
- `createPresignedGetUrl`(`upload.service.ts:283`)：`async (key, expiresInSeconds=300)`，用 `getSignedUrl`，返回 `{url, expiresAt}`。**当前不接受 signingDate**（Step 2 要加）。
- `CreateNoteMediaDto`(`note.dto.ts:53`)：`objectKey`(:66) + `url`(:69) 都 required、client-supplied。`assertMediaOwnership`(`note.service.ts:669`) 要求 objectKey 以 `notes/{ownerID}/` 开头；`assertMediaUrlsAreSafe`(:692) 要求 url/posterUrl 以 `MINIO_PUBLIC_URL` 开头（→ 可从 url strip 前缀反推 key）。
- `collectNote`(:1695) 复制 `objectKey`+`url`；`rewriteCollectedSectionMediaIds`(:1590) 只改 item.id、不动 url/objectKey。**因为 objectKey 一并复制了，presign-on-read 对 collected 笔记照样有效**（冻结的 url 只是不再被读取）。
- 客户端（circle-im）：`NoteDetailScreen.tsx:439` 渲染 `item.url`；`note-card-bubble.tsx:184` / `note-card-payload.ts:65` 用 `cover.url`；唯一变换是 `services/api/utils.ts:64` `normalizeMediaUrl`（只改 host、prod 里 no-op）。笔记**不在任何持久化 store**，每次视图重新 fetch → 显示对 presign-on-read 透明，**客户端显示不用改**。唯一例外：`EditNoteScreen.tsx` 编辑时会把读到的 media `{objectKey,url}` 回传（见 Step 7）。

## 缓存关键点（已验证可行）

`getSignedUrl` 默认用 `new Date()` 做 `X-Amz-Date` → 每次请求 URL 都变 → 击穿 `expo-image` 的按-URL 缓存 → 每次列表刷新重下所有笔记图（主要 UX/流量成本）。

解法：`@smithy/types` 的 `SigningArguments.signingDate` **支持传固定日期**（已在 node_modules 核实）。传一个舍入到时间窗口的 signingDate，同一 objectKey 在窗口内签出**完全相同的 URL** → 缓存命中。TTL 设为窗口+buffer 保证窗口内始终有效。

---

## 实现步骤

### Step 1 — bucket policy 移除 `notes/*`（✅ 本分支已做，TDD 绿）

`src/upload/upload.service.ts` `buildPublicReadBucketPolicy` 的 `publicPrefixes` 删掉 `'notes'`（保留 `'chat'`）。
`src/upload/upload.service.spec.ts` 的 `builds a bucket policy` 测试：从 `toEqual` 的 Resource 数组删 `notes/*` 那行，加：
```ts
expect(JSON.stringify(policy)).not.toContain('circle/notes/*');
expect(JSON.stringify(policy)).toContain('circle/chat/*');
```

### Step 2 — `createPresignedGetUrl` 支持稳定窗口

```ts
async createPresignedGetUrl(
  key: string,
  expiresInSeconds = 300,
  signingDate?: Date,          // 新增：传固定 signingDate 让同窗口 URL 稳定
): Promise<PresignedDownloadResult> {
  if (!this.enabled) throw new ServiceUnavailableException('File upload is not configured');
  const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
  const url = await getSignedUrl(this.publicClient, command, {
    expiresIn: expiresInSeconds,
    ...(signingDate ? { signingDate } : {}),
  });
  return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
}
```
测试：传相同 signingDate 两次 → 期望 getSignedUrl 收到相同 signingDate（mock 断言），确认窗口稳定的接线。

### Step 3 — `note.service` 加 `presignNoteMedia` helper + 常量

```ts
const NOTE_MEDIA_URL_WINDOW_MS = 60 * 60 * 1000;   // 1h 窗口：URL 窗口内稳定，缓存友好
const NOTE_MEDIA_URL_TTL_SECONDS = 2 * 60 * 60;    // 2h：覆盖窗口 + buffer，窗口内始终有效

// 从本站直链反推 object key（assertMediaUrlsAreSafe 保证 url/posterUrl 是 MINIO_PUBLIC_URL 前缀）。
private objectKeyFromUrl(url: string | null | undefined): string | null {
  if (!url || !this.minioPublicUrl) return null;
  const base = `${this.minioPublicUrl.replace(/\/$/, '')}/${this.bucket}/`;  // 确认 bucket 来源
  if (!url.startsWith(base)) return null;
  return url.slice(base.length).split('?')[0];  // strip 已有签名 query
}

// 读取时给一批 objectKey 现签短时 URL。signingDate 舍入到窗口边界（缓存稳定）。
// MinIO 未配置/单个失败时留空 → map 函数 fallback 原 url，不崩。
private async presignNoteMedia(objectKeys: (string | null | undefined)[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(objectKeys.filter((k): k is string => Boolean(k)))];
  if (!unique.length) return map;
  const signingDate = new Date(Math.floor(Date.now() / NOTE_MEDIA_URL_WINDOW_MS) * NOTE_MEDIA_URL_WINDOW_MS);
  await Promise.all(unique.map(async (key) => {
    try {
      const { url } = await this.uploadService.createPresignedGetUrl(key, NOTE_MEDIA_URL_TTL_SECONDS, signingDate);
      map.set(key, url);
    } catch { /* MinIO 未配置 → 略过，fallback 原 url */ }
  }));
  return map;
}
```
> 注意 `minioPublicUrl` 与 `bucket` 的来源：`UploadService` 已有它们；`NoteService` 需要拿到 bucket（或复用一个 UploadService 的 `objectKeyFromUrl` 方法——更干净，把反推也放 UploadService）。**建议把 `objectKeyFromUrl` 放 UploadService**，NoteService 调用，避免 NoteService 里硬编码 minio 细节。

### Step 4 — map 函数加 `presignedUrls` 参数（仅读路径）

- `mapMediaItemForSection(item, presignedUrls?)`：末尾把 `url`/`posterUrl` 替换为 `presignedUrls?.get(item.objectKey) ?? item.url` 和 poster 的反推 key 的签名。**presignedUrls 缺省（写路径）时行为不变（存 base url）。**
- `buildSectionsFromRow(note, presignedUrls)`：三处调 `mapMediaItemForSection` 传入 presignedUrls；**且 :1005-1011 的 verbatim `storedMedia.items` 也要 map 一遍 apply presigned**（这是最易漏的坑）。
- `mapSummary(note, viewerID, presignedUrls)`：cover 的 `url` 替换。
- `mapDetail(note, viewerID, presignedUrls)`：`media[]` 的 url+posterUrl 替换（它内部还调 mapSummary + buildSectionsFromRow，一路传下去）。
- **写路径** `resolveSectionMediaItems`(:759) 调 `mapMediaItemForSection` **不传** presignedUrls → 存 base url 不变。

### Step 5 — 6 个读取入口批量 presign 后传入

`getNote`(:1548)、`listNotes`(:1300 附近)、`collectNote`(:1668 返回)、`updateNote`(:1988)、`createNote`(:1248)、`resolveShareLink`(:1406)。每个：
1. 收集涉及笔记的所有 media `objectKey`（`note.media[].objectKey`）+ 从 `posterUrl` 反推的 key + sections JSON 里 items 的 objectKey。
2. `const presigned = await this.presignNoteMedia(keys)`。
3. 把 `presigned` 传给 `mapDetail`/`mapSummary`。
- list 是 `notes.map(n => mapSummary(...))`：先收集**所有** note 的 cover objectKey 一次性 presign（一个 Map），再同步 map。

### Step 6 — posterUrl（视频封面，无独立 objectKey）

用 Step 3 的 `objectKeyFromUrl(posterUrl)` 反推 key（poster 若也在 `notes/` 前缀下则需 presign；若在别的公开前缀如 covers 则不受影响——按实际 poster 存储前缀确认）。收集 + 替换同 media。

### Step 7 — 写契约（edit 回传签名 url）

`EditNoteScreen` 编辑时把读到的（现在是签名）url 回传到 `CreateNoteMediaDto.url`。`assertMediaUrlsAreSafe` 的前缀 check 会过（同 host），但**会把带签名 query 的 url 存进库然后过期**。修：写路径存 url 前 `url.split('?')[0]` strip 掉签名 query（或让客户端只发 objectKey、服务端从 objectKey 重建 base url 存）。**推荐服务端 strip（防御性，客户端不用改）**：在 `assertMediaUrlsAreSafe` 之后、写库之前，对 url/posterUrl 做 `.split('?')[0]`。

### Step 8 — 客户端（circle-im）

显示**不用改**（透明）。可选：`EditNoteScreen` 只回传 objectKey（若 Step 7 服务端已 strip 则非必需）。

---

## 测试计划（backend jest）

- ✅ bucket policy 不含 `notes/*`、含 `chat/*`（Step 1 已做）。
- `createPresignedGetUrl` 传 signingDate 透传给 getSignedUrl（Step 2）。
- 读取路径（getNote/listNotes/mapDetail）返回**签名 url**（含 `X-Amz-Signature` / 是 presigned map 的值）而非 raw base url。
- **同窗口两次读同一 note → cover/media url 相同**（缓存稳定回归）。
- **写路径**（createNote/updateNote 存 sections）存 **base url**（不含签名 query）——防止签名冻结进库。
- `buildSectionsFromRow` 的 **verbatim storedMedia.items 也被 presign**（专门一个测试，防漏）。
- available gate 行为不变（非 owner 看不到私有笔记——现有测试应仍绿）。
- `collectNote` 后读取仍返回签名 url（objectKey 复制了）。
- MinIO 未配置时 fallback 原 url（不抛）。

## 验证方式（CI 配额耗尽，本地验证）

```bash
# worktree based on origin/main（合并了本 Step 1 分支后从 main）
git worktree add --detach <path> origin/main
cd <path> && ln -sf /Users/yiboding/projects/circle_be/node_modules ./node_modules
npx prisma generate
npx jest src/note src/upload
```
客户端若改动：circle-im `npx tsc --noEmit` + `npm test` + `npm run test:behavior`。
合并：main 无分支保护，`gh pr merge --squash --admin`（配额恢复前 CI 会红，用本地 jest 结果为准）。

## 预估

后端 ~多半天（6 入口 + 4 map 函数 + helper + 读写区分 + 缓存窗口 + 完整测试），客户端基本 0（透明）。主要风险点已在上面「坑」标注：**读/写区分、sections verbatim、posterUrl 反推 key、缓存窗口稳定、edit 写契约 strip**。
