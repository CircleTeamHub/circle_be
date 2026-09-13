import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateConversationGroupDto,
  UpdateConversationGroupDto,
} from './conversation-group.dto';

const errKeys = (cls: any, obj: unknown) =>
  validateSync(plainToInstance(cls, obj)).map((e) => e.property);

// sortOrder 落库是 int4。没有上界时 2^31 会穿过 @IsInt 直达 Prisma,
// 变成一个未映射的引擎错误 → 500。
describe('CreateConversationGroupDto', () => {
  it('rejects a sortOrder above the int4 range', () => {
    expect(
      errKeys(CreateConversationGroupDto, {
        name: 'work',
        sortOrder: 2_147_483_648,
      }),
    ).toContain('sortOrder');
  });

  it('accepts a small sortOrder', () => {
    expect(
      errKeys(CreateConversationGroupDto, { name: 'work', sortOrder: 10 }),
    ).toEqual([]);
  });
});

describe('UpdateConversationGroupDto', () => {
  it('rejects a sortOrder above the int4 range', () => {
    expect(
      errKeys(UpdateConversationGroupDto, { sortOrder: 2_147_483_648 }),
    ).toContain('sortOrder');
  });

  it('accepts a small sortOrder', () => {
    expect(errKeys(UpdateConversationGroupDto, { sortOrder: 10 })).toEqual([]);
  });
});
