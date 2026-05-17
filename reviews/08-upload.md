# Phase 7 — Upload (S3 / MinIO Presign) Review

> 范围:`src/upload/` 全部(`upload.module.ts` / `upload.controller.ts` / `upload.service.ts` / `dto/presign.dto.ts` / `upload.service.spec.ts`)。
> 颗粒度:逐文件逐行。

---

## 0. TL;DR — Top 排序

| # | 严重度 | 位置 | 描述 |
|---|---|---|---|
| 1 | **MED** | [upload.service.ts:110-118](src/upload/upload.service.ts:110) `presign` | 预签名 PUT **无大小上限** —— `getSignedUrl(PutObjectCommand)` 只能签 `ContentType`,无法约束 content-length。客户端可往 `notes/{me}/uuid.mp4` PUT 任意大小(10GB)的对象。note/circle/trace 的 DTO 只限了 `images` 数组**条数**,真实对象体积完全不限 → 存储成本 / 滥用面 |
| 2 | **MED** | [upload.service.ts:72-81,126-134](src/upload/upload.service.ts:72) `onModuleInit` / `ensureBucketExists` | MinIO 配了但启动时不可达 → `HeadBucketCommand` 抛被 catch → `CreateBucketCommand` 抛**未被 catch** → `onModuleInit` reject → **整个 app 启动失败**。应像 OpenIM 那样非阻塞(log + 继续) |
| 3 | **MED** | [upload.controller.ts:25-28](src/upload/upload.controller.ts:25) `userPresignCounts` | 内存 `Map` 限流器**从不清理过期条目** —— `resetAt` 只重置计数,条目永久留存。每个曾 presign 过的用户留一个 entry → 长跑进程内存无界增长 |
| 4 | **MED** | upload 模块整体 | **没有任何删除对象的能力** —— upload-only。note 模块 `updateNote`/`deleteNote` 留下的 S3 孤儿对象(4a #3/#4)因此**永远无法清理**。这是那两个 finding 缺失的另一半 |
| 5 | **MED** | [upload.service.ts:136-143](src/upload/upload.service.ts:136) `ensureBucketIsPublicReadable` | 整个 bucket 被设为 `Principal:'*'` 的 public-read。`notes/{userId}/` 下的私密笔记媒体也因此**世界可读**(仅靠 objectKey 里的 `randomUUID` 不可猜来兜底)。需 confirm 是否接受"private note 媒体 = 公开但不可猜" |
| 6 | LOW | [upload.controller.ts:40](src/upload/upload.controller.ts:40) | `@Req() req: any` —— 应用 `RequestWithUser` |
| 7 | LOW | [upload.service.ts:103](src/upload/upload.service.ts:103) | `filename.split('.').pop()` —— 无扩展名的 filename(如 `avatar`)会让 `ext` 取到整个文件名,`?? 'bin'` 兜不到(pop 永不返回 undefined)→ key 变 `…/uuid.avatar` |
| 8 | LOW | [upload.service.ts](src/upload/upload.service.ts) `presign` | `contentType` 与 `filename` 扩展名不交叉校验 —— `filename: x.jpg` + `contentType: video/mp4` 可并存 |
| 9 | LOW | [upload.service.ts:127-133](src/upload/upload.service.ts:127) | `ensureBucketExists` 的 bare `catch {}` 把"bucket 不存在"与"鉴权失败 / 网络错误"混为一谈 |

共 **9 项**:HIGH 0、MED 5、LOW 4。

---

## 1. `upload.module.ts` (10 lines)
标准 module,`exports: [UploadService]`(供其它模块用,目前无人 inject)。**OK**。

## 2. `upload.controller.ts` (73 lines)

### Walkthrough
- L15-18 类装饰:`@ApiTags` + `@ApiBearerAuth` + **`@UseGuards(JwtGuard)`** ✓
- L25-30 `userPresignCounts` Map + `PRESIGN_LIMIT=20` / `PRESIGN_WINDOW_MS=60_000`
- L34-50 `POST /upload/presign` —— `checkUserPresignLimit(userId)` 后调 service;`@Req() req: any`(LOW-6)
- L52-72 `checkUserPresignLimit` —— 窗口过期则重置计数;超限抛 429
  - 🟠 **MED-3**:Map 条目永不删除

### Findings
- [MED-3] L25 Map 内存泄漏
- [LOW-6] L40 `req: any`

### Verified OK
- JwtGuard;**按 userId 限流**(优于按 IP);超限 429 语义正确

## 3. `dto/presign.dto.ts` (41 lines)

### Walkthrough
- `filename` `@Matches(/^[\w\-. ]+$/)` —— ✅ 阻断 `/` 与异常字符,key 里无路径穿越
- `contentType` `@IsIn(ALLOWED_CONTENT_TYPES)` —— ✅ 白名单(image/* + video/*)
- `folder` `@IsIn(ALLOWED_FOLDERS)` —— ✅ 白名单(avatars/covers/posts/notes)

### Verified OK
- 三个字段全白名单/正则约束;filename 正则防穿越

## 4. `upload.service.ts` (144 lines)

### Walkthrough
- L48-70 ctor:读 MINIO_* env;`enabled = endpoint && accessKey && secretKey`;两个 S3Client(`client` 内网 admin、`publicClient` 公开 URL 签名)
- L72-81 `onModuleInit`:`enabled` 才跑 `ensureBucketExists` + `ensureBucketIsPublicReadable`
  - 🟠 **MED-2**:bucket 创建失败未兜底 → 启动崩
- L92-124 `presign`:
  - `enabled` 关闭 → `ServiceUnavailableException` ✓
  - L103 `ext = filename.split('.').pop() ?? 'bin'`(LOW-7)
  - L106-108 `key = folder/userId/uuid.ext`(有 userId)—— ✅ **按用户命名空间**,note 的 `assertMediaOwnership` 靠它
  - L110-118 `PutObjectCommand({Bucket,Key,ContentType})` + `getSignedUrl` —— ContentType 被签入 URL(客户端无法换类型)✓;**但无 ContentLength → 无大小上限**(MED-1)
  - L121 `fileUrl = ${publicUrl}/${bucket}/${key}` —— ✅ 以 `MINIO_PUBLIC_URL` 开头,正好通过 note/circle/trace 的 `assertUrlsFromStorage`
- L126-134 `ensureBucketExists` —— bare catch(LOW-9)
- L136-143 `ensureBucketIsPublicReadable` —— 整桶 public-read(MED-5)

### Findings
- [MED-1] L110 无大小上限
- [MED-2] L131 建桶失败崩启动
- [MED-5] L136 整桶 public-read
- [LOW-7] L103 ext 提取
- [LOW-8] contentType 不校验扩展名
- [LOW-9] L127 bare catch

### Verified OK ✅
- key **userId 命名空间**(`folder/userId/uuid.ext`)—— note 的写时所有权校验靠它
- `ContentType` 签入预签名 URL —— 客户端不能上传与声明不符的类型
- `filename` 正则防 key 路径穿越
- `contentType` / `folder` 白名单
- `enabled` 门控 —— 未配 MinIO 时干净 503
- `fileUrl` 用 `publicUrl` —— 产出的 URL 正好通过下游存储 origin 守卫
- 两个 client 分工(内网 admin / 公开签名)合理

## 5. `upload.service.spec.ts` (93 lines)
- 3 个测试:bucket policy 构造、onModuleInit 应用 policy、presign 用公开 host 签名
- **缺口**:presign 的 userId 命名空间 key、`enabled=false` 抛 503、限流器、视频 vs 图片的 expiresIn

---

## 6. 修复建议(只列 MED)

| ID | 建议补丁 |
|---|---|
| #1 | 把 `getSignedUrl(PutObjectCommand)` 换成 `createPresignedPost`,带 `content-length-range`(如 image ≤ 10MB、video ≤ 200MB);或在签名里固定 `ContentLength`。这是唯一能在 S3 层强制大小的方式 |
| #2 | `onModuleInit` 包 try/catch:建桶/设策略失败只 `logger.error` + 继续(参考 OpenIM 非阻塞模式),不要让上传子系统拖垮整个 app |
| #3 | `userPresignCounts` 改用项目已有的 `express-rate-limit`(setup.ts 里加一条 `/api/v1/upload/presign` 的 limiter),或给 Map 加定期清理 / 用 LRU |
| #4 | 给 `UploadService` 加 `deleteObject(key)`,并在 note 的 `updateNote`/`deleteNote`(4a #3/#4)里调用清理孤儿对象;或落一个后台 GC job |
| #5 | confirm 产品意图:若私密 note 媒体需要真私密,改桶策略为前缀级(`avatars/*` `covers/*` `posts/*` public,`notes/*` 私有 + 走签名读 URL) |

---

## 7. Phase 7 总评

- **预签名的输入面控制得好**:filename 正则防穿越、contentType/folder 白名单、ContentType 签入 URL、key 按 userId 命名空间、`enabled` 门控、按 userId(非 IP)限流 —— 这些都做对了
- **薄弱面是"对象生命周期与运维健壮性"**:
  - 上传**无大小上限**(MED-1)—— `getSignedUrl(PutObjectCommand)` 的固有局限,必须换 `createPresignedPost`
  - **无删除能力**(MED-4)—— 直接导致 note 模块的 S3 孤儿(4a #3/#4)无解
  - 启动期 MinIO 不可达会**崩 app**(MED-2);限流 Map **内存泄漏**(MED-3)
- **无 HIGH** —— 无路径穿越、无越权(key 命名空间 + JwtGuard)、无未鉴权入口;MED 集中在容量限制、生命周期与运维

下一步:Phase 8 — OpenIM 集成。
