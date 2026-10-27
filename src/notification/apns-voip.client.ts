import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import {
  connect,
  constants as http2Constants,
  type ClientHttp2Session,
} from 'node:http2';
import { reportOperationalError } from 'src/logging/error-aggregation.service';
import type { ApnsEnvironment } from './notification.dto';
import type { TokenDeliveryOutcome } from './notification-push.service';

/**
 * iOS VoIP 推送(PushKit)直连 APNs。
 *
 * 不经极光:来电要 apns-push-type=voip、按 token 选 sandbox / production、
 * apns-expiration 卡在振铃截止 —— 这几样极光的 REST 接口都给不全。鉴权用 .p8
 * 的 token 方式(ES256 JWT),一把 key 同时管 sandbox 与 production,不需要单独的
 * VoIP 证书。只用 Node 自带的 http2 与 crypto,不引新依赖。
 *
 * 失败一律不重试:来电只有 45 秒,重试排队的推送多半到达时已过期。
 */

export const APNS_ORIGINS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  development: 'https://api.sandbox.push.apple.com',
};
/** Apple 要求 provider token 的刷新间隔在 20 到 60 分钟之间。 */
const JWT_TTL_MS = 50 * 60 * 1000;
const APNS_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_VOIP_TOPIC = 'com.yiboding.circleim.voip';

export type ApnsRequest = {
  environment: ApnsEnvironment;
  token: string;
  headers: Record<string, string>;
  body: string;
};
export type ApnsResponse = { status: number; reason?: string };
export interface ApnsTransport {
  send(request: ApnsRequest): Promise<ApnsResponse>;
  close(): void;
}
export const APNS_TRANSPORT = Symbol('APNS_TRANSPORT');

export type VoipPushInput = {
  token: string;
  environment: ApnsEnvironment;
  payload: Record<string, unknown>;
  /** 过了这个时刻 APNs 就不再投递(设备离线攒着的推送,上线时不会补响)。 */
  expiresAt: Date;
};

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** .p8 可以直接贴 PEM(含真换行或 \n 转义),也可以整段 base64。 */
export function parseApnsPrivateKey(raw: string): KeyObject {
  const trimmed = raw.trim();
  const pem = trimmed.includes('-----BEGIN')
    ? trimmed.replace(/\\n/g, '\n')
    : Buffer.from(trimmed, 'base64').toString('utf8');
  return createPrivateKey(pem);
}

/** 410 与 BadDeviceToken 才是「令牌已死」;DeviceTokenNotForTopic 是我们配错了 topic。 */
export function classifyApnsResponse(
  token: string,
  response: ApnsResponse,
): TokenDeliveryOutcome {
  if (response.status === 200) {
    return { token, status: 'SENT', receiptFinal: true };
  }
  const reason = response.reason ?? String(response.status);
  if (response.status === 410) {
    return { token, status: 'TERMINAL', error: 'ApnsUnregistered' };
  }
  if (response.status === 400 && reason === 'BadDeviceToken') {
    return { token, status: 'TERMINAL', error: 'ApnsBadDeviceToken' };
  }
  const retryable =
    response.status === 429 ||
    response.status >= 500 ||
    (response.status === 403 && reason === 'ExpiredProviderToken');
  return {
    token,
    status: retryable ? 'RETRYABLE' : 'TERMINAL',
    error: `ApnsError:${reason}`,
  };
}

/** 每个环境一条长连的 HTTP/2 会话;断了下次发送时重连。 */
export class Http2ApnsTransport implements ApnsTransport {
  private readonly sessions = new Map<ApnsEnvironment, ClientHttp2Session>();

  constructor(
    private readonly origins: Record<ApnsEnvironment, string> = APNS_ORIGINS,
  ) {}

  send(request: ApnsRequest): Promise<ApnsResponse> {
    const session = this.session(request.environment);
    return new Promise((resolve, reject) => {
      const stream = session.request({
        [http2Constants.HTTP2_HEADER_METHOD]: 'POST',
        [http2Constants.HTTP2_HEADER_PATH]: `/3/device/${request.token}`,
        ...request.headers,
      });
      let status = 0;
      let raw = '';
      stream.setEncoding('utf8');
      stream.setTimeout(APNS_REQUEST_TIMEOUT_MS, () => {
        stream.close(http2Constants.NGHTTP2_CANCEL);
        reject(new Error('APNs request timed out'));
      });
      stream.on('response', (headers) => {
        status = Number(headers[http2Constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      stream.on('data', (chunk: string) => {
        raw += chunk;
      });
      stream.on('end', () => {
        let reason: string | undefined;
        if (raw) {
          try {
            reason = (JSON.parse(raw) as { reason?: string }).reason;
          } catch {
            reason = undefined;
          }
        }
        resolve({ status, reason });
      });
      stream.on('error', reject);
      stream.end(request.body);
    });
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private session(environment: ApnsEnvironment): ClientHttp2Session {
    const existing = this.sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(this.origins[environment]);
    const forget = () => {
      if (this.sessions.get(environment) === session) {
        this.sessions.delete(environment);
      }
    };
    session.on('error', forget);
    session.on('goaway', forget);
    session.on('close', forget);
    // 空闲的长连不该拖住进程退出。
    session.unref();
    this.sessions.set(environment, session);
    return session;
  }
}

@Injectable()
export class ApnsVoipClient implements OnModuleDestroy {
  private readonly logger = new Logger(ApnsVoipClient.name);
  private readonly keyId: string;
  private readonly teamId: string;
  private readonly topic: string;
  private readonly privateKey: KeyObject | null;
  private readonly transport: ApnsTransport;
  private cachedJwt: { value: string; issuedAt: number } | null = null;

  constructor(
    config: ConfigService,
    @Optional() @Inject(APNS_TRANSPORT) transport?: ApnsTransport,
  ) {
    this.keyId = config.get<string>('APNS_KEY_ID')?.trim() ?? '';
    this.teamId = config.get<string>('APNS_TEAM_ID')?.trim() ?? '';
    this.topic =
      config.get<string>('APNS_VOIP_TOPIC')?.trim() || DEFAULT_VOIP_TOPIC;
    this.transport = transport ?? new Http2ApnsTransport();
    this.privateKey = this.loadKey(config.get<string>('APNS_PRIVATE_KEY'));
    if (!this.isConfigured()) {
      this.logger.warn(
        'APNs VoIP credentials are not configured; iOS incoming-call pushes are skipped',
      );
    }
  }

  isConfigured(): boolean {
    return Boolean(this.keyId && this.teamId && this.privateKey);
  }

  async send(input: VoipPushInput): Promise<TokenDeliveryOutcome> {
    if (!this.isConfigured()) {
      return {
        token: input.token,
        status: 'RETRYABLE',
        error: 'ApnsNotConfigured',
      };
    }
    try {
      const response = await this.transport.send({
        environment: input.environment,
        token: input.token,
        headers: {
          authorization: `bearer ${this.providerToken()}`,
          'apns-push-type': 'voip',
          'apns-topic': this.topic,
          'apns-priority': '10',
          'apns-expiration': String(
            Math.max(0, Math.floor(input.expiresAt.getTime() / 1000)),
          ),
        },
        body: JSON.stringify(input.payload),
      });
      if (
        response.status === 403 &&
        response.reason === 'ExpiredProviderToken'
      ) {
        this.cachedJwt = null;
      }
      return classifyApnsResponse(input.token, response);
    } catch (error) {
      reportOperationalError(error, {
        component: 'ApnsVoipClient',
        operation: 'send',
        kind: 'apns',
      });
      return {
        token: input.token,
        status: 'RETRYABLE',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  onModuleDestroy(): void {
    this.transport.close();
  }

  /** ES256 provider token;同一把 JWT 复用 50 分钟。 */
  private providerToken(): string {
    const nowMs = Date.now();
    if (this.cachedJwt && nowMs - this.cachedJwt.issuedAt < JWT_TTL_MS) {
      return this.cachedJwt.value;
    }
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.keyId }));
    const claims = base64url(
      JSON.stringify({ iss: this.teamId, iat: Math.floor(nowMs / 1000) }),
    );
    const signingInput = `${header}.${claims}`;
    const signature = sign('sha256', Buffer.from(signingInput), {
      key: this.privateKey!,
      dsaEncoding: 'ieee-p1363',
    });
    const value = `${signingInput}.${base64url(signature)}`;
    this.cachedJwt = { value, issuedAt: nowMs };
    return value;
  }

  private loadKey(raw: string | undefined): KeyObject | null {
    if (!raw?.trim()) return null;
    try {
      return parseApnsPrivateKey(raw);
    } catch (error) {
      // 不把 key 本身或解析细节写进日志。
      this.logger.error(
        `APNS_PRIVATE_KEY is not a valid .p8 key (${error instanceof Error ? error.name : 'Error'})`,
      );
      return null;
    }
  }
}
