import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateNoteDto,
  CreateNoteGroupDto,
  CreateNoteShareLinkDto,
  ListNoteShareLinksQueryDto,
  ReorderNoteGroupsDto,
  UpdateNoteGroupDto,
} from './note.dto';

describe('CreateNoteDto', () => {
  it('rejects duplicated media sort orders', () => {
    const dto = plainToInstance(CreateNoteDto, {
      title: '测试笔记',
      media: [
        {
          type: 'IMAGE',
          objectKey: 'notes/user-1/1.jpg',
          url: 'https://cdn.example.com/1.jpg',
          sortOrder: 0,
        },
        {
          type: 'VIDEO',
          objectKey: 'notes/user-1/1.mp4',
          url: 'https://cdn.example.com/1.mp4',
          sortOrder: 0,
        },
      ],
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'media')).toBe(true);
  });

  it('rejects oversized note titles', () => {
    const dto = plainToInstance(CreateNoteDto, {
      title: 'a'.repeat(121),
      media: [],
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'title')).toBe(true);
  });

  it('rejects DELETED as a writable status', () => {
    const dto = plainToInstance(CreateNoteDto, {
      title: '测试笔记',
      status: 'DELETED',
      media: [],
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });

  it('accepts block contentJson arrays', () => {
    const dto = plainToInstance(CreateNoteDto, {
      title: '测试笔记',
      contentJson: [
        {
          id: 'block-1',
          type: 'heading',
          content: [{ type: 'text', text: '标题' }],
        },
        {
          id: 'block-2',
          type: 'paragraph',
          content: [{ type: 'text', text: '正文' }],
        },
      ],
      media: [],
    });

    const errors = validateSync(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects an empty title', () => {
    const dto = plainToInstance(CreateNoteDto, {
      title: '',
      media: [],
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'title')).toBe(true);
  });

  it('accepts multiple group ids and rejects invalid group id payloads', () => {
    const validDto = plainToInstance(CreateNoteDto, {
      title: '测试笔记',
      groupIds: [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ],
      media: [],
    });

    expect(validateSync(validDto)).toHaveLength(0);

    const invalidDto = plainToInstance(CreateNoteDto, {
      title: '测试笔记',
      groupIds: ['not-a-uuid'],
      media: [],
    });

    expect(
      validateSync(invalidDto).some((error) => error.property === 'groupIds'),
    ).toBe(true);
  });
});

describe('ReorderNoteGroupsDto', () => {
  it('accepts a group id list and rejects non-uuid ids', () => {
    const validDto = plainToInstance(ReorderNoteGroupsDto, {
      groupIds: [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ],
    });

    expect(validateSync(validDto)).toHaveLength(0);

    const invalidDto = plainToInstance(ReorderNoteGroupsDto, {
      groupIds: ['group-1'],
    });

    expect(
      validateSync(invalidDto).some((error) => error.property === 'groupIds'),
    ).toBe(true);
  });
});

// 与 CreateNoteShareLinkDto.title 同一个洞（docs 第 5 节）：@IsNotEmpty 只拒
// '' / null / undefined，放行纯空白。区别是这两处没有硬编码兜底顶着，
// 而是直接把空串写进库 —— createGroup 里 `input.name.trim()` 会真的建出一个
// 名字是空串的分组，createNote 的 derivedTitle 同理。
describe('CreateNoteDto title blankness', () => {
  it('rejects a whitespace-only title', () => {
    const errors = validateSync(
      plainToInstance(CreateNoteDto, { title: '   ', media: [] }),
    );

    expect(errors.some((error) => error.property === 'title')).toBe(true);
  });

  it('trims surrounding whitespace off a valid title', () => {
    const dto = plainToInstance(CreateNoteDto, {
      title: '  出去玩  ',
      media: [],
    });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.title).toBe('出去玩');
  });
});

describe('CreateNoteGroupDto', () => {
  it('rejects a whitespace-only name', () => {
    const errors = validateSync(
      plainToInstance(CreateNoteGroupDto, { name: '   ' }),
    );

    expect(errors.some((error) => error.property === 'name')).toBe(true);
  });

  it('trims surrounding whitespace off a valid name', () => {
    const dto = plainToInstance(CreateNoteGroupDto, { name: '  日记  ' });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.name).toBe('日记');
  });

  it('measures the name length after trimming', () => {
    // 30 字 + 两端空白：trim 后正好卡在 @MaxLength(30) 上，应当放行。
    const dto = plainToInstance(CreateNoteGroupDto, {
      name: `  ${'字'.repeat(30)}  `,
    });

    expect(validateSync(dto)).toHaveLength(0);
  });
});

describe('UpdateNoteGroupDto', () => {
  it('rejects a whitespace-only name', () => {
    const errors = validateSync(
      plainToInstance(UpdateNoteGroupDto, { name: '   ' }),
    );

    expect(errors.some((error) => error.property === 'name')).toBe(true);
  });
});

describe('CreateNoteShareLinkDto', () => {
  it('accepts the current notes view filters and note ids', () => {
    const dto = plainToInstance(CreateNoteShareLinkDto, {
      title: '我的笔记',
      status: 'ACTIVE',
      groupId: '11111111-1111-4111-8111-111111111111',
      search: '咖啡',
      noteIds: [
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
      ],
    });

    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects deleted status and non-uuid note ids', () => {
    const dto = plainToInstance(CreateNoteShareLinkDto, {
      title: '我的笔记',
      status: 'DELETED',
      noteIds: ['note-1'],
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'status')).toBe(true);
    expect(errors.some((error) => error.property === 'noteIds')).toBe(true);
  });

  // docs/note-share-links-todo.md 第 5 节。@IsNotEmpty 只拒 '' / null / undefined，
  // 会放行纯空白标题，服务里再 trim 成空串、落到硬编码的中文兜底 '我的笔记'。
  // 修法是在边界上拒掉，而不是把那个字符串翻译掉：它是内容不是报错，
  // errorCode 那套 i18n 机制（docs/server-error-i18n-rollout.md）套不上，
  // 服务端也不知道调用方的 locale。拒掉之后兜底就是不可达代码，直接删。
  it('rejects a whitespace-only title', () => {
    const errors = validateSync(
      plainToInstance(CreateNoteShareLinkDto, { title: '   ' }),
    );

    expect(errors.some((error) => error.property === 'title')).toBe(true);
  });

  it('trims surrounding whitespace off a valid title', () => {
    const dto = plainToInstance(CreateNoteShareLinkDto, {
      title: '  我的旅行  ',
    });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.title).toBe('我的旅行');
  });

  it('still rejects an empty title', () => {
    const errors = validateSync(
      plainToInstance(CreateNoteShareLinkDto, { title: '' }),
    );

    expect(errors.some((error) => error.property === 'title')).toBe(true);
  });

  it('measures the title length after trimming', () => {
    // 120 个字符 + 两端空白：trim 之后正好卡在 @MaxLength(120) 上，应当放行。
    const dto = plainToInstance(CreateNoteShareLinkDto, {
      title: `  ${'字'.repeat(120)}  `,
    });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.title).toHaveLength(120);
  });

  it('still rejects a title longer than the cap', () => {
    const errors = validateSync(
      plainToInstance(CreateNoteShareLinkDto, { title: '字'.repeat(121) }),
    );

    expect(errors.some((error) => error.property === 'title')).toBe(true);
  });
});

describe('ListNoteShareLinksQueryDto', () => {
  // 查询串永远是字符串，靠 setup.ts 里 ValidationPipe 的 enableImplicitConversion
  // 按 DTO 上的类型转换 —— 这里用 enableImplicitConversion 复现同样的行为。
  const parse = (query: Record<string, unknown>) =>
    plainToInstance(ListNoteShareLinksQueryDto, query, {
      enableImplicitConversion: true,
    });

  it('accepts a numeric page and limit from query string values', () => {
    const dto = parse({ page: '2', limit: '20' });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(20);
  });

  it('accepts an empty query and leaves the defaults to the service', () => {
    const dto = parse({});

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.page).toBeUndefined();
    expect(dto.limit).toBeUndefined();
  });

  it('rejects a limit above the per-page cap', () => {
    // 没有 @Max 的话，limit=100000 会让一个请求把整张表拉出来。
    const errors = validateSync(parse({ limit: '100000' }));

    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });

  it('rejects a zero or negative page', () => {
    // page=0 会让 skip 算成负数，Prisma 会直接报错。
    expect(
      validateSync(parse({ page: '0' })).some((e) => e.property === 'page'),
    ).toBe(true);
    expect(
      validateSync(parse({ page: '-1' })).some((e) => e.property === 'page'),
    ).toBe(true);
  });

  it('rejects a non-integer limit', () => {
    const errors = validateSync(parse({ limit: 'abc' }));

    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });
});
