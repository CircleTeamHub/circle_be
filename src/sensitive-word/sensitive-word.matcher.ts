/**
 * sensitive-word.matcher.ts — 纯函数敏感词匹配器（零依赖）
 *
 * 词表规模（≤ 数万）与聊天消息长度（≤ 数 KB）下，逐位置 trie 前缀走查
 * 已是微秒级，无需引第三方 AC 自动机库。匹配前把文本压缩为「仅保留
 * 字母/数字/汉字」的形态（NFKC 全角转半角 + 小写 + 去空白/标点/控制符），
 * 使「赌 博」「代.开.发.票」这类拆字规避也能命中；只回答"是否命中 +
 * 命中哪个词"，不需要原文位置，所以压缩不影响正确性。
 */

/** 空白 / 标点 / 符号 / 控制符（含零宽字符）——匹配时全部忽略。 */
const IGNORED_CHARS = /[\s\p{C}\p{P}\p{S}\p{Z}]/gu;

/** 词条入库前的规范形态：NFKC + 去零宽 + 小写 + 裁剪首尾空白。 */
export function normalizeSensitiveWord(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase()
    .trim();
}

/** 匹配用压缩形态：在规范化基础上再去掉全部空白/标点/符号。 */
function compact(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(IGNORED_CHARS, '');
}

interface TrieNode {
  children: Map<string, TrieNode>;
  /** 终结节点存的原词条（规范形态），用于命中上报。 */
  word: string | null;
}

function newNode(): TrieNode {
  return { children: new Map(), word: null };
}

export interface SensitiveWordMatcher {
  /** 构建时实际收录的词条数（去重、剔空后）。 */
  readonly size: number;
  /** 返回文本中最先出现的命中词条；未命中返回 null。 */
  findFirst(text: string): string | null;
}

export function buildSensitiveWordMatcher(
  words: readonly string[],
): SensitiveWordMatcher {
  const root = newNode();
  const seen = new Set<string>();

  for (const raw of words) {
    const normalized = normalizeSensitiveWord(raw);
    const key = compact(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    let node = root;
    for (const ch of key) {
      let next = node.children.get(ch);
      if (!next) {
        next = newNode();
        node.children.set(ch, next);
      }
      node = next;
    }
    node.word = normalized;
  }

  const size = seen.size;

  function findFirst(text: string): string | null {
    if (size === 0 || !text) return null;
    const haystack = Array.from(compact(text));
    for (let i = 0; i < haystack.length; i++) {
      let node: TrieNode | undefined = root;
      for (let j = i; j < haystack.length; j++) {
        node = node.children.get(haystack[j]);
        if (!node) break;
        if (node.word !== null) return node.word;
      }
    }
    return null;
  }

  return { size, findFirst };
}
