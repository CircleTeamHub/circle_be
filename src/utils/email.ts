/** 邮箱归一化：去空格 + 转小写。注册/登录/发码必须经此统一，避免大小写造成查不到用户。 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
