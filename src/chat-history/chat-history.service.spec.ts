import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ChatHistoryQueryDto } from './dto/chat-history.dto';

describe('ChatHistory DTOs', () => {
  it('caps message page size through query validation metadata', () => {
    const dto = plainToInstance(ChatHistoryQueryDto, {
      limit: '500',
      beforeSeq: '42',
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });
});
