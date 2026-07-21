import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
  WebhookReceiver,
} from 'livekit-server-sdk';
import type { CallType } from 'src/generated/prisma';

type MintJoinTokenInput = {
  identity: string;
  name?: string;
  roomName: string;
  callType: CallType;
  metadata?: string;
};

type CreateRoomInput = {
  name: string;
  maxParticipants: number;
  metadata?: string;
};

// #109：LiveKit 出站调用超时。RoomServiceClient 不接受 AbortSignal（Twirp
// 内部自持 fetch），用 Promise.race 兜底 —— 与 openim.service 的
// AbortSignal.timeout 同一个动机：LiveKit 不可达且不 RST 时，发起通话的请求
// 不该挂到平台默认超时。竞输的原请求会在后台自然结束，无资源泄漏风险
//（HTTP 请求自身有 socket 生命周期）。
const LIVEKIT_REQUEST_TIMEOUT_MS = 5_000;

async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`${label} timed out after ${LIVEKIT_REQUEST_TIMEOUT_MS}ms`),
        ),
      LIVEKIT_REQUEST_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class LiveKitCallService {
  private readonly logger = new Logger(LiveKitCallService.name);
  private readonly url: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly tokenTtlSeconds: number;
  private readonly roomService: RoomServiceClient | null;
  private readonly webhookReceiver: WebhookReceiver | null;

  constructor(private readonly config: ConfigService) {
    this.url = this.readConfig('LIVEKIT_URL');
    this.apiKey = this.readConfig('LIVEKIT_API_KEY');
    this.apiSecret = this.readConfig('LIVEKIT_API_SECRET');
    this.tokenTtlSeconds = this.readPositiveInt(
      this.config.get<string>('LIVEKIT_TOKEN_TTL_SECONDS'),
      3600,
    );
    this.roomService =
      this.url && this.apiKey && this.apiSecret
        ? new RoomServiceClient(this.url, this.apiKey, this.apiSecret)
        : null;
    this.webhookReceiver =
      this.apiKey && this.apiSecret
        ? new WebhookReceiver(this.apiKey, this.apiSecret)
        : null;
  }

  getClientUrl(): string {
    this.assertConfigured();
    return this.url;
  }

  async createRoom(input: CreateRoomInput): Promise<void> {
    this.assertConfigured();

    try {
      await withTimeout(
        this.roomService!.createRoom({
          name: input.name,
          maxParticipants: input.maxParticipants,
          metadata: input.metadata,
        }),
        'LiveKit createRoom',
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const normalized = reason.toLowerCase();
      if (
        normalized.includes('already exists') ||
        normalized.includes('already_exists')
      ) {
        return;
      }
      throw new ServiceUnavailableException('LiveKit room creation failed');
    }
  }

  async deleteRoom(roomName: string): Promise<void> {
    this.assertConfigured();

    try {
      await withTimeout(
        this.roomService!.deleteRoom(roomName),
        'LiveKit deleteRoom',
      );
    } catch (error) {
      this.logger.warn(
        `Failed to delete LiveKit room ${roomName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async mintJoinToken(input: MintJoinTokenInput): Promise<string> {
    this.assertConfigured();

    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: input.identity,
      name: input.name,
      metadata: input.metadata,
      ttl: this.tokenTtlSeconds,
    });

    token.addGrant({
      roomJoin: true,
      room: input.roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canPublishSources:
        input.callType === 'VIDEO'
          ? [TrackSource.MICROPHONE, TrackSource.CAMERA]
          : [TrackSource.MICROPHONE],
    });

    return token.toJwt();
  }

  async verifyWebhook(body: string, authHeader: string | undefined) {
    if (!this.webhookReceiver) {
      throw new ServiceUnavailableException('LiveKit is not configured');
    }
    return this.webhookReceiver.receive(body, authHeader);
  }

  private assertConfigured(): void {
    if (!this.roomService) {
      throw new ServiceUnavailableException('LiveKit is not configured');
    }
  }

  private readConfig(key: string): string {
    return (this.config.get<string>(key) ?? '').trim();
  }

  private readPositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
