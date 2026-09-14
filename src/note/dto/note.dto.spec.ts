import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateNoteDto,
  CreateNoteExportDto,
  CreateNoteGroupDto,
  CreateNoteMediaDto,
  CreateNoteShareLinkDto,
  ListNoteShareLinksQueryDto,
  ListNotesQueryDto,
  NOTE_REMARK_MAX_LENGTH,
  NoteLocationSectionDto,
  RecycleBinQueryDto,
  ReorderNoteGroupsDto,
  SetNoteRemarkDto,
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

describe('SetNoteRemarkDto', () => {
  it('accepts a remark, explicit null (clear), and absent field', () => {
    for (const body of [{ remark: '重要客户' }, { remark: null }, {}]) {
      const errors = validateSync(plainToInstance(SetNoteRemarkDto, body));
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects remarks above the length cap and non-string payloads', () => {
    for (const body of [
      { remark: 'a'.repeat(NOTE_REMARK_MAX_LENGTH + 1) },
      { remark: 123 },
    ]) {
      const errors = validateSync(plainToInstance(SetNoteRemarkDto, body));
      expect(errors.some((error) => error.property === 'remark')).toBe(true);
    }
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

  it('accepts a UUID cursor and numeric limit from query string values', () => {
    const dto = parse({
      cursor: '11111111-1111-4111-8111-111111111111',
      limit: '20',
    });

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.cursor).toBe('11111111-1111-4111-8111-111111111111');
    expect(dto.limit).toBe(20);
  });

  it('accepts an empty query and leaves the defaults to the service', () => {
    const dto = parse({});

    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.cursor).toBeUndefined();
    expect(dto.limit).toBeUndefined();
  });

  it('rejects a limit above the per-page cap', () => {
    const errors = validateSync(parse({ limit: '101' }));

    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });

  it('rejects a malformed cursor', () => {
    const errors = validateSync(parse({ cursor: 'not-a-uuid' }));

    expect(errors.some((error) => error.property === 'cursor')).toBe(true);
  });

  it('rejects a non-integer limit', () => {
    const errors = validateSync(parse({ limit: 'abc' }));

    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });
});

describe('CreateNoteMediaDto integer fields stay within Postgres int4', () => {
  // NoteMedia.size/width/height/durationMs/sortOrder 都是 Int 列：超过 2^31-1 的值
  // 会穿过 DTO 直达 Prisma，写入时抛未映射错误 → 500，而不是 400。
  const INT4_MAX = 2_147_483_647;
  const errorFor = (property: string, value: number) =>
    validateSync(
      plainToInstance(CreateNoteMediaDto, {
        type: 'IMAGE',
        objectKey: 'notes/user-1/1.jpg',
        url: 'https://cdn.example.com/1.jpg',
        sortOrder: 0,
        [property]: value,
      }),
    ).find((error) => error.property === property);

  it.each(['size', 'width', 'height', 'durationMs', 'sortOrder'])(
    'rejects %s above int4 max and accepts the max itself',
    (property) => {
      expect(errorFor(property, INT4_MAX + 1)).toHaveProperty(
        'constraints.max',
      );
      expect(errorFor(property, INT4_MAX)).toBeUndefined();
    },
  );
});

// app 的 fetchNotes / fetchDeletedNotes 从不传 page/limit：默认页必须装得下整本笔记，
// 否则超过默认页（以前 50）的笔记被静默截掉。显式上限同样放到 500。
describe('note list query limits', () => {
  it('ListNotesQueryDto defaults limit to 500 and caps it at 500', () => {
    const parse = (query: Record<string, unknown>) =>
      plainToInstance(ListNotesQueryDto, query, {
        enableImplicitConversion: true,
      });

    const empty = parse({});
    expect(validateSync(empty)).toHaveLength(0);
    expect(empty.limit).toBe(500);
    expect(validateSync(parse({ limit: '500' }))).toHaveLength(0);
    expect(
      validateSync(parse({ limit: '501' })).map((error) => error.property),
    ).toContain('limit');
  });

  it('RecycleBinQueryDto defaults limit to 500 and caps it at 500', () => {
    const parse = (query: Record<string, unknown>) =>
      plainToInstance(RecycleBinQueryDto, query, {
        enableImplicitConversion: true,
      });

    const empty = parse({});
    expect(validateSync(empty)).toHaveLength(0);
    expect(empty.limit).toBe(500);
    expect(validateSync(parse({ limit: '500' }))).toHaveLength(0);
    expect(
      validateSync(parse({ limit: '501' })).map((error) => error.property),
    ).toContain('limit');
  });
});

describe('NoteLocationSectionDto coordinate bounds', () => {
  // 位置选择器只会给出真实经纬度；越界值只可能是伪造或脏数据，落库后地图渲染出错。
  const errorsFor = (location: Record<string, unknown>) =>
    validateSync(plainToInstance(NoteLocationSectionDto, location)).map(
      (error) => error.property,
    );

  it('accepts real coordinates, the exact edges, and null / missing values', () => {
    expect(errorsFor({ latitude: 37.7749, longitude: -122.4194 })).toEqual([]);
    expect(errorsFor({ latitude: -90, longitude: 180 })).toEqual([]);
    expect(errorsFor({ latitude: 90, longitude: -180 })).toEqual([]);
    // app 的 EditNoteScreen 只选了地址时会发 latitude / longitude: null。
    expect(
      errorsFor({ title: '咖啡馆', latitude: null, longitude: null }),
    ).toEqual([]);
    expect(errorsFor({ title: '咖啡馆' })).toEqual([]);
  });

  it('rejects latitude outside [-90, 90] and longitude outside [-180, 180]', () => {
    expect(errorsFor({ latitude: 90.0001, longitude: 0 })).toEqual([
      'latitude',
    ]);
    expect(errorsFor({ latitude: -91, longitude: 0 })).toEqual(['latitude']);
    expect(errorsFor({ latitude: 0, longitude: 180.5 })).toEqual(['longitude']);
    expect(errorsFor({ latitude: 0, longitude: -181 })).toEqual(['longitude']);
  });
});

describe('CreateNoteExportDto scope', () => {
  // app 只发 scope: 'ALL'；另一种合法值是媒体 id（UUID）。给自由字符串一个上界。
  const errorsFor = (scope: string) =>
    validateSync(
      plainToInstance(CreateNoteExportDto, { format: 'IMAGES', scope }),
    ).map((error) => error.property);

  it('accepts ALL, a media id, and 64 characters; rejects longer scopes', () => {
    expect(errorsFor('ALL')).toEqual([]);
    expect(errorsFor('11111111-1111-4111-8111-111111111111')).toEqual([]);
    expect(errorsFor('x'.repeat(64))).toEqual([]);
    expect(errorsFor('x'.repeat(65))).toEqual(['scope']);
  });
});
