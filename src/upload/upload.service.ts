import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

export interface PresignResult {
  uploadUrl: string;
  fileUrl: string;
  key: string;
}

@Injectable()
export class UploadService implements OnModuleInit {
  private readonly logger = new Logger(UploadService.name);
  private readonly client: S3Client;
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
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn(
        'MinIO is not configured (MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY missing). Upload features will be skipped.',
      );
      return;
    }
    await this.ensureBucketExists();
  }

  /**
   * 生成预签名上传 URL
   * @param filename  原始文件名，用于提取扩展名
   * @param contentType  MIME type，例如 image/jpeg
   * @param folder  存储目录，例如 avatars、covers
   * @param expiresIn  URL 有效秒数，默认 300（5 分钟）
   */
  async presign(
    filename: string,
    contentType: string,
    folder = 'uploads',
    expiresIn = contentType.startsWith('video/') ? 1800 : 300,
  ): Promise<PresignResult> {
    const ext = filename.split('.').pop() ?? 'bin';
    const key = `${folder}/${randomUUID()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn });

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
}
