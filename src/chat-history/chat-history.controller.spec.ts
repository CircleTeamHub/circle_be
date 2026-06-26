import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { ChatHistoryController } from './chat-history.controller';

// Metadata key set by @nestjs/swagger's @ApiResponse (DECORATORS.API_RESPONSE).
// Inlined because @nestjs/swagger@>=11.4 ships an `exports` map that blocks the
// internal `@nestjs/swagger/dist/constants` deep import this test used to use.
const SWAGGER_API_RESPONSE_METADATA = 'swagger/apiResponse';

describe('ChatHistoryController', () => {
  it('passes current user, conversation id, and query options to service', async () => {
    const service = {
      getMessages: jest.fn().mockResolvedValue({ messages: [] }),
    };
    const controller = new ChatHistoryController(service as any);

    await controller.getMessages(
      { user: { userId: 'user-1' } } as any,
      'si_a_b',
      { limit: 50, beforeSeq: 10 },
    );

    expect(service.getMessages).toHaveBeenCalledWith(
      'user-1',
      'si_a_b',
      50,
      10,
    );
  });

  it('requires authentication and throttles restore reads', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ChatHistoryController);
    const getMessages = ChatHistoryController.prototype.getMessages;

    expect(guards).toEqual([ThrottlerGuard, JwtGuard]);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', getMessages)).toBe(30);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', getMessages)).toBe(
      60_000,
    );
  });

  it('documents expected auth, not-found, and rate-limit responses', () => {
    const responses = Reflect.getMetadata(
      SWAGGER_API_RESPONSE_METADATA,
      ChatHistoryController.prototype.getMessages,
    );

    expect(Object.keys(responses).sort((a, b) => a.localeCompare(b))).toEqual([
      '200',
      '401',
      '404',
      '429',
    ]);
  });
});
