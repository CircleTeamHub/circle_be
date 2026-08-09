import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ClampPagePipe, MAX_PAGE } from './pagination';
import { ListCirclesQueryDto } from '../circle/dto/circle.dto';
import { PlazaFeedQueryDto } from '../circle-plaza/dto/circle-plaza.dto';
import { TraceFeedQueryDto } from '../trace/dto/trace.dto';

// OFFSET 的代价与页码成正比、与返回行数无关：Postgres 要先产出并丢弃 skip 之前的
// 每一行。所以 ?page=100000000&limit=100 是一次全表扫描换 100 行，请求便宜、服务端
// 昂贵。limit 一直有 @Max，page 长期漏了。
describe('offset pagination bounds', () => {
  it.each([
    ['ListCirclesQueryDto', ListCirclesQueryDto],
    ['PlazaFeedQueryDto', PlazaFeedQueryDto],
    ['TraceFeedQueryDto', TraceFeedQueryDto],
  ])('%s rejects a page beyond MAX_PAGE', async (_name, Dto) => {
    const tooDeep = plainToInstance(
      Dto as never,
      {
        page: MAX_PAGE + 1,
      } as never,
    );
    const errors = await validate(tooDeep as object, {
      skipMissingProperties: true,
    });
    expect(errors.map((e) => e.property)).toContain('page');

    const allowed = plainToInstance(Dto as never, { page: MAX_PAGE } as never);
    const okErrors = await validate(allowed as object, {
      skipMissingProperties: true,
    });
    expect(okErrors.map((e) => e.property)).not.toContain('page');
  });

  it('every page field in the codebase carries a @Max', () => {
    // 断言的是「不再有漏网的 page」，而不是某几个文件 —— 新增列表接口时若忘了加
    // @Max，这条会红。DTO 里 page 的两种写法都覆盖：`page?: number` 与 `page = 1`。
    const files = [
      'src/circle/dto/circle.dto.ts',
      'src/circle-plaza/dto/circle-plaza.dto.ts',
      'src/note/dto/note.dto.ts',
      'src/trace/dto/trace.dto.ts',
      'src/user/dto/get-user.dto.ts',
      'src/friend/dto/friend-report-admin.dto.ts',
      'src/admin-community/admin-community.dto.ts',
      'src/admin-user/dto/admin-user.dto.ts',
      'src/moderation/moderation-admin.controller.ts',
    ];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      // 每个 @Min(1) 之后、page 声明之前，必须出现 @Max(MAX_PAGE)。
      const pageBlocks = source.match(
        /@Min\(1\)[\s\S]{0,200}?page[?]?(?:\s*=\s*1)?[:;]/g,
      );
      expect(pageBlocks).not.toBeNull();
      for (const block of pageBlocks ?? []) {
        expect(block).toContain('@Max(MAX_PAGE)');
      }
    }
  });
});

describe('ClampPagePipe', () => {
  // 这条路径没有 DTO（@Query('page', ParseIntPipe)），@Max 管不到，只能靠管道。
  const pipe = new ClampPagePipe();

  it('clamps instead of throwing, because the param is best-effort', () => {
    expect(pipe.transform(100_000_000)).toBe(MAX_PAGE);
    expect(pipe.transform(0)).toBe(1);
    expect(pipe.transform(-5)).toBe(1);
  });

  it('leaves a normal page untouched', () => {
    expect(pipe.transform(1)).toBe(1);
    expect(pipe.transform(7)).toBe(7);
    expect(pipe.transform(MAX_PAGE)).toBe(MAX_PAGE);
  });

  it('survives non-finite input rather than propagating NaN into skip', () => {
    // NaN 会让 (page-1)*limit 变成 NaN，Prisma 的 skip 收到 NaN 会直接抛。
    // 非有限值一律退回第一页而不是夹到 MAX_PAGE：ParseIntPipe 本就产不出这种值，
    // 真出现了说明输入已经不可信，退回最便宜的那一页比「尽量满足」更安全。
    expect(pipe.transform(Number.NaN)).toBe(1);
    expect(pipe.transform(Number.POSITIVE_INFINITY)).toBe(1);
    expect(pipe.transform(Number.NEGATIVE_INFINITY)).toBe(1);
  });
});
