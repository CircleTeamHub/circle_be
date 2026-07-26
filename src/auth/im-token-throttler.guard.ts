import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class ImTokenThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = (req.user as { userId?: unknown } | undefined)?.userId;
    if (typeof userId === 'string' && userId.length > 0) {
      return `user:${userId}`;
    }
    return super.getTracker(req);
  }
}
