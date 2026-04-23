import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
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
}

export function buildPublicReadBucketPolicy(bucket: string) {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'PublicReadGetObject',
        Effect: 'Allow',
        Principal: '*',
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
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

  constructor(private config: ConfigService) {
    const endpoint = this.config.get<string>('MINIO_ENDPOINT') ?? '';
    const accessKey = this.config.get<string>('MINIO_ACCESS_KEY') ?? '';
    const secretKey = this.config.get<string>('MINIO_SECRET_KEY') ?? '';
    this.bucket = this.config.get<string>('MINIO_BUCKET') ?? 'circle';
    this.publicUrl = this.config.get<string>('MINIO_PUBLIC_URL') ?? endpoint;

    this.enabled = Boolean(endpoint && accessKey && secretKey);

    this.client = new S3Client({
      endpoint,
      region: 'us-east-1', // MinIO 需要填但值随意
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle: true, // MinIO 必须开启
    });

    this.publicClient = new S3Client({
      endpoint: this.publicUrl,
      region: 'us-east-1',
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle: true,
    });
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn(
        'MinIO is not configured (MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY missing). Upload features will be skipped.',
      );
      return;
    }
    await this.ensureBucketExists();
    await this.ensureBucketIsPublicReadable();
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
    folder = 'uploads',
    userId?: string,
    expiresIn = contentType.startsWith('video/') ? 1800 : 300,
  ): Promise<PresignResult> {
    if (!this.enabled) {
      throw new ServiceUnavailableException('File upload is not configured');
    }

    const ext = filename.split('.').pop() ?? 'bin';
    // Include userId in the path so the note service can enforce per-user
    // media ownership at write time without trusting the client-supplied key.
    const key = userId
      ? `${folder}/${userId}/${randomUUID()}.${ext}`
      : `${folder}/${randomUUID()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });

    let uploadUrl: string;
    const start = Date.now();
    let result: 'success' | 'failure' = 'success';
    try {
      uploadUrl = await getSignedUrl(this.publicClient, command, {
        expiresIn,
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

    return { uploadUrl, fileUrl, key };
  }

  private async ensureBucketExists() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      this.logger.log(`Bucket "${this.bucket}" not found, creating...`);
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Bucket "${this.bucket}" created.`);
    }
  }

  private async ensureBucketIsPublicReadable() {
    await this.client.send(
      new PutBucketPolicyCommand({
        Bucket: this.bucket,
        Policy: buildPublicReadBucketPolicy(this.bucket),
      }),
    );
  }
}
