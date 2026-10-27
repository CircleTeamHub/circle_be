import { Prisma } from 'src/generated/prisma';

/** 客户端时区里的一天:'YYYY-MM-DD' 与它对应的 UTC 区间 [start, end)。 */
export type MessageDayWindow = { day: string; start: Date; end: Date };

function formatZonedDate(formatter: Intl.DateTimeFormat, date: Date): string {
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

/** 该时区里 year-month-day 当地零点对应的 UTC 毫秒(±36h 内二分;月、日可溢出)。 */
function findUtcStartOfZonedDate(
  formatter: Intl.DateTimeFormat,
  year: number,
  month: number,
  day: number,
): number {
  const normalized = new Date(Date.UTC(year, month, day));
  const target = normalized.toISOString().slice(0, 10);
  let low = normalized.getTime() - 36 * 60 * 60 * 1000;
  let high = normalized.getTime() + 36 * 60 * 60 * 1000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (formatZonedDate(formatter, new Date(middle)) < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * 某月(month 0-based,与 JS Date 一致)按客户端时区切成的每一天。时区规则与原来
 * 逐条消息归日完全一样:给了 IANA timeZone 就按它(夏令时切换日自然是 23/25 小时),
 * 否则按 tzOffsetMinutes(getTimezoneOffset 语义)平移。每天的区间首尾相接,
 * 第一天的 start / 最后一天的 end 就是原来的月界。
 *
 * 日界在应用里用 Intl 算,而不是交给 SQL 的 AT TIME ZONE:DTO 用 @IsTimeZone 按
 * Intl 校验时区名,PostgreSQL 的时区库未必认得同一批名字、规则也未必同版本。
 */
export function messageDayWindows(
  year: number,
  month: number,
  tzOffsetMinutes = 0,
  timeZone?: string,
): MessageDayWindow[] {
  const formatter = timeZone
    ? new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
    : undefined;
  const startOf = (day: number) =>
    formatter
      ? findUtcStartOfZonedDate(formatter, year, month, day)
      : Date.UTC(year, month, day) + tzOffsetMinutes * 60_000;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const starts = Array.from({ length: daysInMonth + 1 }, (_, i) =>
    startOf(i + 1),
  );
  if (!starts.every(Number.isFinite)) return [];
  return Array.from({ length: daysInMonth }, (_, i) => ({
    day: new Date(Date.UTC(year, month, i + 1)).toISOString().slice(0, 10),
    start: new Date(starts[i]),
    end: new Date(starts[i + 1]),
  }));
}

/**
 * 这些天里哪些天有本人看得见的消息(日期日历上色用)。原来是不带 orderBy 取 5000 行
 * createdAt 回应用去重 —— 活跃月份超过 5000 条时取回哪 5000 条由执行计划决定,随机
 * 漏天。现在逐天问一次「有没有一条」:每天沿 (conversationID, createdAt) WHERE
 * deleted = false 的部分索引探一下,碰到第一条可见的就停,一次最多 31 次探测。
 *
 * 可见性与 getHistory 同一把尺子:清空水位之上(height > heightFloor,水位为 0 时恒真)、
 * 未焚毁(chatRetentionWhere 当前只剩阅后即焚到期这一条;那边改了这里要跟着改,
 * chat-message-days.query.spec 钉着)。`deleted = false` 必须是字面量,部分索引才用得上。
 *
 * 区间以 UTC 墙钟字符串传入、按 timestamp 解释(createdAt 是不带时区的 UTC 墙钟),
 * 与会话时区设置无关。
 */
export function messageDaysQuery(
  conversationId: string,
  heightFloor: number,
  windows: MessageDayWindow[],
): Prisma.Sql {
  return Prisma.sql`
    SELECT d.day
    FROM unnest(
      ${windows.map((w) => w.day)}::text[],
      ${windows.map((w) => w.start.toISOString())}::timestamp[],
      ${windows.map((w) => w.end.toISOString())}::timestamp[]
    ) AS d(day, "start", "end")
    WHERE EXISTS (
      SELECT 1
      FROM "ChatMessage" AS m
      WHERE m."conversationID" = ${conversationId}
        AND m."deleted" = false
        AND m."createdAt" >= d."start"
        AND m."createdAt" < d."end"
        AND m."height" > ${heightFloor}
        AND (m."burnExpiresAt" IS NULL OR m."burnExpiresAt" > NOW())
    )
  `;
}
