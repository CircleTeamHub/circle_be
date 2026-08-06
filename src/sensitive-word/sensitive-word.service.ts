import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  buildSensitiveWordMatcher,
  normalizeSensitiveWord,
  type SensitiveWordMatcher,
} from './sensitive-word.matcher';

/** 词表缓存刷新周期。到期后由下一次 check 触发后台刷新，不阻塞判定。 */
const REFRESH_TTL_MS = 60_000;

export interface SensitiveWordVerdict {
  blocked: boolean;
  /** 命中的词条（规范形态）。仅 blocked 时存在。 */
  word?: string;
}

/**
 * 敏感词服务：词表存 DB，匹配走内存 trie。
 *
 * check 在 OpenIM before-send 回调热路径上（每条消息一次），必须同步、
 * 零 IO —— 词表变更靠 CRUD 后立即重建 + TTL 后台刷新兜底（多实例场景
 * 下其他实例最迟 TTL 内收敛）。词表加载失败一律 fail-open：宁可漏拦，
 * 不能把全站发消息打挂。
 */
@Injectable()
export class SensitiveWordService implements OnModuleInit {
  private readonly logger = new Logger(SensitiveWordService.name);
  private matcher: SensitiveWordMatcher | null = null;
  private loadedAt = 0;
  private reloadPromise: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.reload();
    } catch (error) {
      // fail-open：启动时词表加载失败不阻断应用，后续 TTL 刷新会重试。
      this.logger.error(
        `敏感词词表启动加载失败，暂时放行所有消息: ${String(error)}`,
      );
    }
  }

  /** 同步判定文本是否包含敏感词。缓存过期时踢一次后台刷新。 */
  check(text: string): SensitiveWordVerdict {
    if (Date.now() - this.loadedAt >= REFRESH_TTL_MS) {
      this.scheduleReload();
    }
    if (!this.matcher) return { blocked: false };
    const word = this.matcher.findFirst(text);
    return word === null ? { blocked: false } : { blocked: true, word };
  }

  async listWords(): Promise<{
    total: number;
    words: {
      id: string;
      word: string;
      createdAt: Date;
      createdBy: string | null;
    }[];
  }> {
    const words = await this.prisma.sensitiveWord.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return { total: words.length, words };
  }

  /** 批量新增（规范化 + 去重 + skipDuplicates），成功后立即重建匹配器。 */
  async addWords(
    rawWords: string[],
    createdBy: string,
  ): Promise<{ requested: number; added: number }> {
    const words = this.normalizeBatch(rawWords);
    if (words.length === 0) {
      return { requested: rawWords.length, added: 0 };
    }
    const result = await this.prisma.sensitiveWord.createMany({
      data: words.map((word) => ({ word, createdBy })),
      skipDuplicates: true,
    });
    await this.reload();
    return { requested: rawWords.length, added: result.count };
  }

  /** 批量删除（按规范形态精确匹配），成功后立即重建匹配器。 */
  async removeWords(
    rawWords: string[],
    _removedBy: string,
  ): Promise<{ removed: number }> {
    const words = this.normalizeBatch(rawWords);
    if (words.length === 0) return { removed: 0 };
    const result = await this.prisma.sensitiveWord.deleteMany({
      where: { word: { in: words } },
    });
    await this.reload();
    return { removed: result.count };
  }

  private normalizeBatch(rawWords: string[]): string[] {
    const seen = new Set<string>();
    for (const raw of rawWords) {
      const word = normalizeSensitiveWord(raw);
      if (word) seen.add(word);
    }
    return [...seen];
  }

  private scheduleReload(): void {
    if (this.reloadPromise) return;
    this.reloadPromise = this.reload()
      .catch((error) => {
        // fail-open：刷新失败保留旧匹配器继续用。
        this.logger.error(`敏感词词表刷新失败: ${String(error)}`);
      })
      .finally(() => {
        this.reloadPromise = null;
      });
  }

  private async reload(): Promise<void> {
    const rows = await this.prisma.sensitiveWord.findMany({
      select: { word: true },
    });
    this.matcher = buildSensitiveWordMatcher(rows.map((r) => r.word));
    this.loadedAt = Date.now();
    this.logger.log(`敏感词词表已加载：${this.matcher.size} 条`);
  }
}
