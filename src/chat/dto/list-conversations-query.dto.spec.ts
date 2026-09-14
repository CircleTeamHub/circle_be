import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CONVERSATION_LIST_LIMIT_MAX } from '../chat.constants';
import { ListConversationsQueryDto } from './list-conversations-query.dto';

// 与全局 ValidationPipe 同一组选项（src/setup.ts）。
function parse(query: Record<string, unknown>) {
  const dto = plainToInstance(ListConversationsQueryDto, query, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
}

describe('ListConversationsQueryDto', () => {
  it('accepts no limit, which is what installed App builds send', () => {
    expect(parse({}).errors).toHaveLength(0);
  });

  it('coerces a query-string limit up to the cap', () => {
    const { dto, errors } = parse({
      limit: String(CONVERSATION_LIST_LIMIT_MAX),
    });

    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(CONVERSATION_LIST_LIMIT_MAX);
  });

  it('rejects a limit below 1 or beyond the cap', () => {
    expect(parse({ limit: 0 }).errors).not.toHaveLength(0);
    expect(
      parse({ limit: CONVERSATION_LIST_LIMIT_MAX + 1 }).errors,
    ).not.toHaveLength(0);
  });
});
