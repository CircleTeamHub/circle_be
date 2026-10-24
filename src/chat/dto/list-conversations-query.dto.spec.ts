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

  // cursor 是键集分页的开关：不带 = 旧的活跃度排序（已装机 App 永远不带）；
  // 带上（哪怕是空串）= 按 conversationID 升序翻页。
  describe('cursor', () => {
    const CONVERSATION_ID = '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f';

    it('stays undefined when the client sends no cursor (legacy mode)', () => {
      const { dto, errors } = parse({});

      expect(errors).toHaveLength(0);
      expect(dto.cursor).toBeUndefined();
    });

    // @IsOptional() 只跳过 null/undefined，不跳过空串 —— 空串是「从头开始」的
    // 合法取值，必须单独放行，否则客户端连第一页都拿不到。
    it('accepts an empty-string cursor as "start from the beginning"', () => {
      const { dto, errors } = parse({ cursor: '' });

      expect(errors).toHaveLength(0);
      expect(dto.cursor).toBe('');
    });

    it('accepts a conversation id cursor', () => {
      const { dto, errors } = parse({ cursor: CONVERSATION_ID, limit: '50' });

      expect(errors).toHaveLength(0);
      expect(dto.cursor).toBe(CONVERSATION_ID);
      expect(dto.limit).toBe(50);
    });

    // 会话 id 由 Prisma uuid() 生成，全是小写；游标按文本比较，大写游标不归一化
    // 的话会和小写 id 排在不同位置，翻页静默跳行。
    it('normalizes an upper-case conversation id to the stored lower-case form', () => {
      const { dto, errors } = parse({ cursor: CONVERSATION_ID.toUpperCase() });

      expect(errors).toHaveLength(0);
      expect(dto.cursor).toBe(CONVERSATION_ID);
    });

    it.each([
      ['a slug', 'conv-1'],
      ['whitespace', ' '],
      ['a 32-hex id without dashes', CONVERSATION_ID.replace(/-/g, '')],
      ['an id with trailing garbage', `${CONVERSATION_ID}x`],
      ['an id wrapped in whitespace', ` ${CONVERSATION_ID} `],
      ['a SQL fragment', "' OR 1=1 --"],
      ['a repeated query parameter', [CONVERSATION_ID, CONVERSATION_ID]],
      ['a number', 42],
    ])('rejects %s', (_case, cursor) => {
      const { errors } = parse({ cursor });

      expect(errors.map((error) => error.property)).toEqual(['cursor']);
    });
  });
});
