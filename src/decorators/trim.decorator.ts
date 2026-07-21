import { Transform } from 'class-transformer';

/**
 * 字符串字段先 trim 再交给校验器。搭配 `@IsNotEmpty()` 用来在边界拒掉纯空白输入。
 *
 * 为什么需要：class-validator 的 `@IsNotEmpty` 判的是 `value !== '' && != null`，
 * **放行纯空白**（`'   '`）。这类值一路走到服务层才被 `.trim()` 成空串，然后要么
 * 写进库变成空名（如 `createGroup` 会真的建出名字是空串的分组），要么撞上硬编码
 * 兜底把「客户端传了空值」这个 bug 悄悄盖掉（见 docs/note-share-links-todo.md 第 5 节）。
 *
 * 副作用（想要的）：`@MaxLength` 量的是 trim 后的长度，两端带空白的合法值不再被误拒。
 *
 * 非字符串原样返回，让 `@IsString()` 去报错，而不是在这里吞掉类型问题。
 *
 * ⚠️ **不要用在密码 / token / 密钥上**：那些字段的首尾空白是有效字符，
 * 静默改写会让用户设的密码登不进去。本装饰器只适用于用户可见的文本内容与名称。
 */
export function Trim(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}
