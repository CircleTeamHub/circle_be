/**
 * 历史遗留的用户 id 归一:OpenIM 时代聊天面传的是去连字符 32-hex,
 * REST 面传标准 UUID。聊天已切自研栈(全程 UUID),此归一只为兼容
 * 旧客户端缓存里的 hex 形态,输入已是 UUID 时原样返回。
 */
export function normalizeUserIdAlias(id: string): string {
  if (/^[0-9a-f]{32}$/i.test(id)) {
    const hex = id.toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
      12,
      16,
    )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return id;
}
