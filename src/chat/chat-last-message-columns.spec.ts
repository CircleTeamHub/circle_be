import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Prisma } from 'src/generated/prisma';

/**
 * 会话列表里每个会话的「最后一条消息」是手写 SQL(每会话倒序取最高 height 的一条),
 * 结果按 MessageRow(= ChatMessage 去掉 contentHistory)交给 toMessageDto。
 * 原始 SQL 绕过 Prisma 的类型检查:漏选一列 tsc 照过,DTO 上对应字段静默变成
 * undefined。revision 就这样漏过一次 —— 会话列表的 lastMessage 不带变更序号,
 * 客户端合并时分不清新旧快照。
 *
 * 这里拿 Prisma 生成的列清单去对 SELECT 列表:ChatMessage 以后加列,要么在这条
 * SQL 里选上,要么在下面显式说明为什么不选。
 */
describe('loadLastMessages raw SELECT', () => {
  /** 刻意不选的列:contentHistory 是编辑前的原文,列表末条不该把它拖出来。 */
  const NOT_SELECTED = new Set(['contentHistory']);
  const byName = (a: string, b: string): number => a.localeCompare(b);

  function selectedColumns(): string[] {
    const source = readFileSync(
      resolve(process.cwd(), 'src/chat/chat.service.ts'),
      'utf8',
    );
    const start = source.indexOf('private async loadLastMessages(');
    expect(start).toBeGreaterThan(-1);
    const select =
      /CROSS JOIN LATERAL \(\s*SELECT([\s\S]*?)FROM "ChatMessage" AS m/.exec(
        source.slice(start),
      );
    expect(select).not.toBeNull();
    return [...select![1].matchAll(/m\."(\w+)"/g)].map((match) => match[1]);
  }

  it('selects every ChatMessage column the DTO mapper may read', () => {
    const expected = Object.values(Prisma.ChatMessageScalarFieldEnum)
      .filter((column) => !NOT_SELECTED.has(column))
      .sort(byName);

    expect([...selectedColumns()].sort(byName)).toEqual(expected);
  });
});
