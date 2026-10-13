import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  reportHandledJobFailure,
  TrackedCron,
} from '../metrics/tracked-cron.decorator';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * 修复被清空的笔记正文结构，与迁移
 * 20261013000000_repair_wiped_note_content_json 是**同一组语句**
 * （note-content-json-repair.spec.ts 逐条比对迁移文件，防两份 SQL 漂移）。
 * 「被清空」= 非空数组、且每个元素都是空数组（[[], [], ...]）；只按行内数据
 * 判断、可重复执行、不碰 updatedAt：顶层 contentJson 置 NULL，
 * sections.text.contentJson 整个键删掉，客户端回退显示纯文本 content。
 *
 * 逐字写成无插值的模板标签（#112 禁裸 SQL 字符串）。jsonb_array_length 对非数组
 * 会直接报错，而 Postgres 不保证 AND 的求值顺序，所以类型判断必须放在 CASE 里。
 */
export const NOTE_CONTENT_JSON_REPAIR_STATEMENTS: readonly Prisma.Sql[] = [
  Prisma.sql`UPDATE "Note"
SET "contentJson" = NULL
WHERE CASE
  WHEN jsonb_typeof("contentJson") = 'array' THEN
    jsonb_array_length("contentJson") > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements("contentJson") AS block
      WHERE jsonb_typeof(block) <> 'array' OR jsonb_array_length(block) <> 0
    )
  ELSE false
END`,
  Prisma.sql`UPDATE "Note"
SET "sections" = "sections" #- '{text,contentJson}'
WHERE CASE
  WHEN jsonb_typeof("sections" -> 'text' -> 'contentJson') = 'array' THEN
    jsonb_array_length("sections" -> 'text' -> 'contentJson') > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements("sections" -> 'text' -> 'contentJson') AS block
      WHERE jsonb_typeof(block) <> 'array' OR jsonb_array_length(block) <> 0
    )
  ELSE false
END`,
  Prisma.sql`UPDATE "NoteDraft"
SET "contentJson" = NULL
WHERE CASE
  WHEN jsonb_typeof("contentJson") = 'array' THEN
    jsonb_array_length("contentJson") > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements("contentJson") AS block
      WHERE jsonb_typeof(block) <> 'array' OR jsonb_array_length(block) <> 0
    )
  ELSE false
END`,
  Prisma.sql`UPDATE "NoteDraft"
SET "sections" = "sections" #- '{text,contentJson}'
WHERE CASE
  WHEN jsonb_typeof("sections" -> 'text' -> 'contentJson') = 'array' THEN
    jsonb_array_length("sections" -> 'text' -> 'contentJson') > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements("sections" -> 'text' -> 'contentJson') AS block
      WHERE jsonb_typeof(block) <> 'array' OR jsonb_array_length(block) <> 0
    )
  ELSE false
END`,
];

/**
 * 发布后的兜底复跑。蓝绿发布先跑迁移、新色健康后才切流
 * （deploy/release-deploy.sh），这段窗口里——以及新色没起来、旧色继续服务的
 * 整段时间里——旧版本未修复的 DTO 还会写出 [[], ...]，迁移已经跑过、不会再
 * 补救。新版本里定时重跑同一组幂等语句，把切流前漏网的行收回来。
 *
 * 删除时机见 DEPLOY.md「笔记正文 contentJson 修复」：本版本成功切流、旧色已停，
 * 且之后至少跑过一轮（日志里没有修复计数）即可在下个版本删掉这个任务。
 */
@Injectable()
export class NoteContentJsonRepair {
  private readonly logger = new Logger(NoteContentJsonRepair.name);

  constructor(private readonly prisma: PrismaService) {}

  @TrackedCron(CronExpression.EVERY_HOUR, 'note_content_json_repair')
  async sweep(): Promise<void> {
    try {
      let repaired = 0;
      for (const statement of NOTE_CONTENT_JSON_REPAIR_STATEMENTS) {
        repaired += await this.prisma.$executeRaw(statement);
      }
      if (repaired > 0) {
        this.logger.warn(
          `repaired ${repaired} wiped note contentJson field(s)`,
        );
      }
    } catch (err) {
      // 修复失败不影响业务（客户端看到的是空白正文），下一轮会重试。
      this.logger.error(
        'note contentJson repair failed',
        err instanceof Error ? err.stack : String(err),
      );
      reportHandledJobFailure();
    }
  }
}
