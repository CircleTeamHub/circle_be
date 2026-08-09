import { UploadErrorCode } from 'src/common/app-error-codes';
import { CHAT_ONLY_UPLOAD_TYPES } from './dto/presign.dto';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logExternalCallFailure } from 'src/logging/external-service.logger';
import { logExternalCallSlow } from 'src/logging/performance-event.logger';

export interface PresignResult {
  uploadUrl: string;
  fileUrl: string;
  key: string;
  requiredHeaders: Record<string, string>;
}

export interface UploadBufferInput {
  key: string;
  body: Buffer;
  contentType: string;
  expiresInSeconds?: number;
}

export interface UploadBufferResult {
  url: string;
  key: string;
  size: number;
  expiresAt: Date | null;
}

export interface PresignedDownloadResult {
  url: string;
  expiresAt: Date;
}

export function buildPublicReadBucketPolicy(bucket: string) {
  const publicPrefixes = [
    'avatars',
    'covers',
    'posts',
    // 'notes' 已移除：私有笔记(available:false)的媒体不再匿名可读，改由 note.service
    // 读取时发短时签名 URL(presign-on-read)。历史直链 url 仍在库里但不再被读取路径返回。
    // 'chat' 已移除：原先保留的唯一理由是「图 URL 固化在 OpenIM 消息体、无法迁移历史」，
    // 而自研聊天栈落地后 OpenIM 已出清，ChatMessage 存的是 key 而不是 URL，读取一律走
    // ChatMediaService 的 presign-on-read。留着 chat/* 匿名可读的话，发送侧的归属校验
    // (chat/{senderId}/ 命名空间)和读取侧的短时签名就全是摆设 —— 拿到过 key 的人可以
    // 无限期直连对象存储，绕过所有会话成员校验。
    'friends',
    'uploads',
  ];
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'PublicReadGetObject',
        Effect: 'Allow',
        Principal: '*',
        Action: ['s3:GetObject'],
        Resource: publicPrefixes.map(
          (prefix) => `arn:aws:s3:::${bucket}/${prefix}/*`,
        ),
      },
    ],
  });
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function errorRecord(error: unknown): Record<string, unknown> | null {
  return error && typeof error === 'object'
    ? (error as Record<string, unknown>)
    : null;
}

function redactLogValue(value: string) {
  return value.replace(
    /(token|secret|password|authorization)=\S+/gi,
    '$1=[redacted]',
  );
}

function errorMessage(error: unknown, record: Record<string, unknown> | null) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return record ? stringField(record, 'message') : null;
}

function errorName(error: unknown, record: Record<string, unknown> | null) {
  if (error instanceof Error && error.name.trim()) {
    return error.name.trim();
  }
  return record ? stringField(record, 'name') : null;
}

function errorCode(record: Record<string, unknown> | null) {
  if (!record) return null;
  return stringField(record, 'Code') ?? stringField(record, 'code');
}

function formatMinioBootstrapError(error: unknown) {
  if (typeof error === 'string' && error.trim()) {
    return redactLogValue(error.trim());
  }

  const record = errorRecord(error);
  const metadata = errorRecord(record?.['$metadata']);
  const message = errorMessage(error, record);
  const name = errorName(error, record);
  const code = errorCode(record);
  const status = metadata ? numberField(metadata, 'httpStatusCode') : null;
  const requestId = metadata ? stringField(metadata, 'requestId') : null;
  const attempts = metadata ? numberField(metadata, 'attempts') : null;

  const parts = [
    name ? `name=${redactLogValue(name)}` : null,
    code ? `code=${redactLogValue(code)}` : null,
    message ? `message=${redactLogValue(message)}` : null,
    status ? `status=${status}` : null,
    requestId ? `requestId=${redactLogValue(requestId)}` : null,
    attempts ? `attempts=${attempts}` : null,
  ].filter(Boolean);

  return parts.length ? parts.join(' ') : 'UnknownError';
}

function isMissingBucketError(error: unknown) {
  const record = errorRecord(error);
  const metadata = errorRecord(record?.['$metadata']);
  const status = metadata ? numberField(metadata, 'httpStatusCode') : null;
  const name = errorName(error, record);
  const code = errorCode(record);

  return (
    status === 404 ||
    name === 'NotFound' ||
    name === 'NoSuchBucket' ||
    code === 'NoSuchBucket'
  );
}

@Injectable()
export class UploadService implements OnModuleInit {
  private readonly logger = new Logger(UploadService.name);
  private readonly loggingConfig = createLoggingConfig();
  private readonly client: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;
  private readonly enabled: boolean;
  private readonly production: boolean;
  private ready = false;
  // 与 `ready` 分开跟踪：ready 涵盖「桶存在 + 策略已应用」，而只有策略这一项关乎
  // 「私有笔记媒体是否真的私有」。见 objectStoreStatus()。
  private mediaPolicyApplied = false;
  private bootstrapPromise: Promise<boolean> | null = null;
  private nextBootstrapAttemptAt = 0;

  constructor(private config: ConfigService) {
    const endpoint = this.config.get<string>('MINIO_ENDPOINT') ?? '';
    const accessKey = this.config.get<string>('MINIO_ACCESS_KEY') ?? '';
    const secretKey = this.config.get<string>('MINIO_SECRET_KEY') ?? '';
    this.bucket = this.config.get<string>('MINIO_BUCKET') ?? 'circle';
    this.publicUrl = this.config.get<string>('MINIO_PUBLIC_URL') ?? endpoint;
    this.production =
      (this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV) ===
      'production';

    this.enabled = Boolean(endpoint && accessKey && secretKey);

    this.client = new S3Client({
      endpoint,
      region: 'us-east-1', // MinIO 需要填但值随意
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle: true, // MinIO 必须开启
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });

    this.publicClient = new S3Client({
      endpoint: this.publicUrl,
      region: 'us-east-1',
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }

  async onModuleInit() {
    if (!this.enabled) {
      if (this.production) {
        throw new ServiceUnavailableException(
          'Private media storage is not configured',
        );
      }
      this.logger.warn(
        'MinIO is not configured (MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY missing). Upload features will be skipped.',
      );
      return;
    }
    // Bucket bootstrap must not crash the whole app: if MinIO is unreachable
    // at boot, log and continue — `presign` surfaces a clean 503 to callers,
    // the rest of the app stays up.
    try {
      this.ready = await this.bootstrap();
      if (!this.ready && this.production) {
        throw new ServiceUnavailableException(
          'Private media storage policy could not be applied',
        );
      }
    } catch (error) {
      if (this.production) throw error;
      this.logger.error(
        `MinIO bucket bootstrap failed; upload features may be degraded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 生成预签名上传 URL
   * @param filename    原始文件名，用于提取扩展名
   * @param contentType MIME type，例如 image/jpeg
   * @param folder      存储目录，例如 avatars、covers
   * @param userId      当前用户 ID。传入时 key 格式为 `folder/userId/uuid.ext`，
   *                    使 assertMediaOwnership 可以按用户前缀校验所有权。
   * @param expiresIn   URL 有效秒数，默认 300（5 分钟）
   */
  async presign(
    filename: string,
    contentType: string,
    sizeBytes: number,
    folder = 'uploads',
    userId?: string,
    expiresIn = contentType.startsWith('video/') ? 1800 : 300,
  ): Promise<PresignResult> {
    if (!this.enabled) {
      throw new ServiceUnavailableException('File upload is not configured');
    }
    if (!(await this.ensureReady())) {
      throw new ServiceUnavailableException(
        'File upload is temporarily unavailable',
      );
    }

    // 语音/文件只对 chat 目录开放。DTO 的白名单是全局的,只放宽它等于让头像、
    // 封面、圈子帖目录也能收 pdf/zip —— 目录收口必须在这里再做一次。
    if (CHAT_ONLY_UPLOAD_TYPES.includes(contentType) && folder !== 'chat') {
      throw new BadRequestException({
        message: `${contentType} uploads are only allowed in chat`,
        errorCode: UploadErrorCode.InvalidContentType,
      });
    }

    // 按类分档:视频 100 MiB 照旧;语音是几十秒的片段,给 20 MiB 已经很宽;
    // 文件给 50 MiB —— 比视频紧,避免 chat 目录变成通用网盘。
    const maxBytes = contentType.startsWith('video/')
      ? 100 * 1024 * 1024
      : contentType.startsWith('audio/')
        ? 20 * 1024 * 1024
        : CHAT_ONLY_UPLOAD_TYPES.includes(contentType)
          ? 50 * 1024 * 1024
          : 20 * 1024 * 1024;
    if (
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      sizeBytes > maxBytes
    ) {
      throw new PayloadTooLargeException({
        message: `Upload exceeds the ${maxBytes / (1024 * 1024)} MiB limit`,
        errorCode: UploadErrorCode.PayloadTooLarge,
      });
    }

    // `split('.').pop()` returns the whole string when there is no dot, so
    // gate on an actual extension and fall back to `bin`.
    const ext = filename.includes('.')
      ? filename.split('.').pop() || 'bin'
      : 'bin';
    // Include userId in the path so the note service can enforce per-user
    // media ownership at write time without trusting the client-supplied key.
    const key = userId
      ? `${folder}/${userId}/${randomUUID()}.${ext}`
      : `${folder}/${randomUUID()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
      IfNoneMatch: '*',
    });

    let uploadUrl: string;
    const start = Date.now();
    let result: 'success' | 'failure' = 'success';
    try {
      uploadUrl = await getSignedUrl(this.publicClient, command, {
        expiresIn,
        signableHeaders: new Set(['content-type']),
      });
    } catch (error) {
      result = 'failure';
      logExternalCallFailure(this.logger, {
        enabled: this.loggingConfig.externalLogOn,
        service: 'minio',
        operation: 'presign_put_object',
        durationMs: Date.now() - start,
        error,
      });
      throw error;
    } finally {
      logExternalCallSlow(this.logger, {
        enabled: this.loggingConfig.performanceLogOn,
        service: 'minio',
        operation: 'presign_put_object',
        durationMs: Date.now() - start,
        thresholdMs: this.loggingConfig.slowExternalMs,
        result,
      });
    }

    // 把 uploadUrl 里的内网地址替换为公开访问地址
    const fileUrl = `${this.publicUrl}/${this.bucket}/${key}`;

    return {
      uploadUrl,
      fileUrl,
      key,
      requiredHeaders: {
        'Content-Type': contentType,
        'Content-Length': String(sizeBytes),
        'If-None-Match': '*',
      },
    };
  }

  /**
   * 分页列出某个前缀下的对象。目前只服务于存量盘点（StorageAuditService）。
   *
   * 刻意不提供删除方法：本仓库至今没有任何一处删除 MinIO 对象，先把「哪些对象没人
   * 引用」查清楚、人工核对过，再谈删。判错一个对象就是删掉用户的头像或笔记配图。
   */
  async listObjects(
    prefix: string,
    continuationToken?: string,
  ): Promise<{
    objects: { key: string; size: number; lastModified: Date | null }[];
    nextContinuationToken?: string;
  }> {
    if (!this.enabled) {
      return { objects: [] };
    }

    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );

    return {
      objects: (response.Contents ?? [])
        .filter((item): item is typeof item & { Key: string } =>
          Boolean(item.Key),
        )
        .map((item) => ({
          key: item.Key,
          size: item.Size ?? 0,
          lastModified: item.LastModified ?? null,
        })),
      nextContinuationToken: response.IsTruncated
        ? response.NextContinuationToken
        : undefined,
    };
  }

  async uploadBuffer(input: UploadBufferInput): Promise<UploadBufferResult> {
    if (!this.enabled) {
      throw new ServiceUnavailableException('File upload is not configured');
    }

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    });

    const start = Date.now();
    let result: 'success' | 'failure' = 'success';
    try {
      await this.client.send(command);
    } catch (error) {
      result = 'failure';
      logExternalCallFailure(this.logger, {
        enabled: this.loggingConfig.externalLogOn,
        service: 'minio',
        operation: 'put_object',
        durationMs: Date.now() - start,
        error,
      });
      throw error;
    } finally {
      logExternalCallSlow(this.logger, {
        enabled: this.loggingConfig.performanceLogOn,
        service: 'minio',
        operation: 'put_object',
        durationMs: Date.now() - start,
        thresholdMs: this.loggingConfig.slowExternalMs,
        result,
      });
    }

    const ttl = input.expiresInSeconds ?? null;
    return {
      url: `${this.publicUrl}/${this.bucket}/${input.key}`,
      key: input.key,
      size: input.body.byteLength,
      expiresAt: ttl ? new Date(Date.now() + ttl * 1000) : null,
    };
  }

  async createPresignedGetUrl(
    key: string,
    expiresInSeconds = 300,
    signingDate?: Date,
  ): Promise<PresignedDownloadResult> {
    if (!this.enabled) {
      throw new ServiceUnavailableException('File upload is not configured');
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    // signingDate 传入时用它做 X-Amz-Date：调用方(note.service presignNoteMedia)把它舍入到
    // 时间窗口，同窗口内同一 key 签出字节相同的 URL，客户端(expo-image)按-URL 缓存才能命中，
    // 否则每次请求 URL 都变、列表刷新就重下所有笔记图。
    const url = await getSignedUrl(this.publicClient, command, {
      expiresIn: expiresInSeconds,
      ...(signingDate ? { signingDate } : {}),
    });
    return {
      url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    };
  }

  /**
   * 从本站直链反推 object key（fileUrl = `${publicUrl}/${bucket}/${key}` 的逆）。
   * presign-on-read 用它处理只有 url、没有独立 objectKey 的字段（如 NoteMedia.posterUrl）。
   * off-origin / 空 → null（不把外链误当本站 key）；读取路径回给的签名 url 里的 query 会被 strip。
   */
  objectKeyFromPublicUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const base = `${this.publicUrl.replace(/\/$/, '')}/${this.bucket}/`;
    if (!url.startsWith(base)) return null;
    return url.slice(base.length).split('?')[0];
  }

  async downloadObjectBuffer(key: string, maxBytes?: number): Promise<Buffer> {
    if (!this.enabled) {
      throw new ServiceUnavailableException('File upload is not configured');
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    const response = await this.client.send(command);
    if (
      typeof maxBytes === 'number' &&
      typeof response.ContentLength === 'number' &&
      response.ContentLength > maxBytes
    ) {
      const body = response.Body as { destroy?: () => void } | undefined;
      body?.destroy?.();
      throw new PayloadTooLargeException(
        'Object exceeds maximum download size',
      );
    }
    if (!response.Body) {
      return Buffer.alloc(0);
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      totalBytes += chunk.byteLength;
      if (typeof maxBytes === 'number' && totalBytes > maxBytes) {
        const body = response.Body as { destroy?: () => void } | undefined;
        body?.destroy?.();
        throw new PayloadTooLargeException(
          'Object exceeds maximum download size',
        );
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private async ensureBucketExists() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!isMissingBucketError(error)) {
        throw error;
      }
      this.logger.log(`Bucket "${this.bucket}" not found, creating...`);
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Bucket "${this.bucket}" created.`);
    }
  }

  private async ensureReady(): Promise<boolean> {
    if (this.ready) return true;
    if (Date.now() < this.nextBootstrapAttemptAt) return false;
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.bootstrap().finally(() => {
        this.bootstrapPromise = null;
      });
    }
    this.ready = await this.bootstrapPromise;
    if (!this.ready) this.nextBootstrapAttemptAt = Date.now() + 5_000;
    return this.ready;
  }

  private async bootstrap(): Promise<boolean> {
    let step: 'ensure_bucket_exists' | 'put_bucket_policy' =
      'ensure_bucket_exists';
    try {
      await this.ensureBucketExists();
      step = 'put_bucket_policy';
      await this.ensureBucketIsPublicReadable();
      return true;
    } catch (error) {
      // error（不是 warn）并且点名后果：这条失败意味着桶策略没换上，notes/* 可能
      // 仍然匿名可读，而应用照常发预签名 URL —— 表面上一切正常。readiness 探针
      // 的 objectStore 字段会同步报 policy-unconfirmed。
      this.logger.error(
        `MinIO bootstrap attempt failed during ${step}: ${formatMinioBootstrapError(error)}. ` +
          'The private-media bucket policy may not be in force — notes/* could still be anonymously readable.',
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }
  }

  private async ensureBucketIsPublicReadable() {
    await this.client.send(
      new PutBucketPolicyCommand({
        Bucket: this.bucket,
        Policy: buildPublicReadBucketPolicy(this.bucket),
      }),
    );
    this.mediaPolicyApplied = true;
  }

  /**
   * 桶策略是否确认应用成功 —— 供 readiness 探针观测。
   *
   * 为什么这个状态必须外露：buildPublicReadBucketPolicy 是**白名单**，`notes` 已被
   * 移出，所以「应用这条策略」正是让私有笔记媒体变私有的那个动作。它在启动时是
   * best-effort（失败只打日志、应用照常起来），一旦失败，**旧策略继续生效、桶仍然
   * 匿名可读**，而读取路径照发预签名 URL —— 从外部看毫无异样，P0 实际没修上。
   *
   * 刻意不用它去 gate 预签名：签名是本地 SigV4 计算，不需要 MinIO 在线；拿它挡读
   * 只会把「MinIO 短暂不可达」放大成「所有笔记媒体读取全挂」。
   */
  objectStoreStatus(): 'ok' | 'policy-unconfirmed' | 'disabled' {
    if (!this.enabled) return 'disabled';
    return this.mediaPolicyApplied ? 'ok' : 'policy-unconfirmed';
  }
}
