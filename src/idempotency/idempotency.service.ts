import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { IdempotencyErrorCode } from 'src/common/app-error-codes';
import { RedisService } from 'src/redis/redis.service';

/**
 * 每个接入的创建接口一个作用域，拼进 Redis 键：同一个客户端键打到两个接口上
 * 互不相干。新增接入点在这里加一项，不要复用别人的。
 */
export const IdempotencyScope = {
  ChatGroupCreate: 'chat-group-create',
  CircleCreate: 'circle-create',
  MomentCreate: 'moment-create',
  MomentCommentCreate: 'moment-comment-create',
  PlazaPostCreate: 'plaza-post-create',
  NoteShareLinkCreate: 'note-share-link-create',
  CallInvite: 'call-invite',
} as const;
export type IdempotencyScope =
  (typeof IdempotencyScope)[keyof typeof IdempotencyScope];

export interface IdempotentRequest {
  scope: IdempotencyScope;
  userId: string;
  /** 原样的 Idempotency-Key 请求头；没带就是 undefined。 */
  key: string | undefined;
  /** 已校验的 DTO（连同路由参数）；它的规范化 JSON 就是这次请求的指纹。 */
  request: unknown;
}

type IdempotencyRecord =
  | { state: 'pending'; fingerprint: string; token: string }
  | { state: 'done'; fingerprint: string; response: unknown };

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
// 占位只需撑过一次请求：到期还没写成 done，说明那次请求已经死了，放下一次重试进来。
const PENDING_TTL_SECONDS = 60;
const DONE_TTL_SECONDS = 24 * 60 * 60;

/**
 * 可选 Idempotency-Key 的请求层重放：超时后带同一个键重试，拿回第一次的响应，
 * 不再建第二份。只做「同一个人、同一个接口、同一份请求」的去重，业务规则照旧由
 * operation 自己把关；带键请求在 Redis 不可用时拒绝执行，避免失去重放保护后创建
 * 重复数据。没带键的旧客户端仍按原路径执行。
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly redis: RedisService) {}

  async run<T>(
    { scope, userId, key, request }: IdempotentRequest,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (key === undefined) return operation();
    if (!KEY_PATTERN.test(key)) {
      throw new BadRequestException({
        message: 'Idempotency-Key 格式不正确',
        errorCode: IdempotencyErrorCode.KeyInvalid,
      });
    }

    const redisKey = `idem:v1:${scope}:${userId}:${key}`;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify(request, (_name, value: unknown) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(
                Object.keys(value)
                  .sort((a, b) => a.localeCompare(b))
                  .map((name) => [
                    name,
                    (value as Record<string, unknown>)[name],
                  ]),
              )
            : value,
        ),
      )
      .digest('hex');
    const pending: IdempotencyRecord = {
      state: 'pending',
      fingerprint,
      token: randomUUID(),
    };

    const claim = await this.redis.setJsonIfAbsent(
      redisKey,
      pending,
      PENDING_TTL_SECONDS,
    );
    if (claim === null) {
      this.logger.warn(
        `Idempotency store unavailable; rejecting ${scope} to preserve replay protection`,
      );
      throw new ServiceUnavailableException({
        message: '幂等保护暂不可用，请稍后重试',
      });
    }
    // strictNullChecks 关着，按 stored 字面量收窄不生效，改用 in。
    if ('current' in claim) {
      const current = claim.current as IdempotencyRecord;
      if (current.fingerprint !== fingerprint) {
        throw new ConflictException({
          message: '该 Idempotency-Key 已用于另一个请求',
          errorCode: IdempotencyErrorCode.KeyReused,
        });
      }
      if (current.state === 'pending') {
        throw new ConflictException({
          message: '同一请求正在处理中，请稍后重试',
          errorCode: IdempotencyErrorCode.InProgress,
        });
      }
      return current.response as T;
    }

    let response: T;
    try {
      response = await operation();
    } catch (error) {
      // 比对整条占位记录再删：占位过期后被别的请求重新占走的，不能误删。
      await this.redis.releaseLease(redisKey, JSON.stringify(pending));
      throw error;
    }
    await this.redis.setJson(
      redisKey,
      { state: 'done', fingerprint, response } satisfies IdempotencyRecord,
      DONE_TTL_SECONDS,
    );
    return response;
  }
}
