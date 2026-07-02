// 前后端共享的稳定错误码。抛异常时用 `throw new XException({ message, errorCode })`,
// all-exception.filter 会把 errorCode 透传进响应信封;前端按 code 映射本地化文案
// (i18n `serverErrors.<code>`),缺 key 时回落后端 message。
//
// 约定:message 仍保留人类可读的中文默认值(兼容旧客户端 / 非 App 消费方 / 现有测试),
// errorCode 才是给前端做多语言映射的机器码。新增错误码时,前端 locale 的 serverErrors
// 也要补上对应 key。
export const AuthErrorCode = {
  InvalidCredentials: 'AUTH_INVALID_CREDENTIALS',
  EmailTaken: 'AUTH_EMAIL_TAKEN',
  CodeInvalid: 'AUTH_CODE_INVALID',
  AccountIdTaken: 'AUTH_ACCOUNT_ID_TAKEN',
  SecurityCodeInvalid: 'AUTH_SECURITY_CODE_INVALID',
  SecurityCodeLocked: 'AUTH_SECURITY_CODE_LOCKED',
} as const;

export const CoinErrorCode = {
  SelfTransfer: 'COIN_SELF_TRANSFER',
  NotFriend: 'COIN_NOT_FRIEND',
  Insufficient: 'COIN_INSUFFICIENT',
  AmountInvalid: 'COIN_AMOUNT_INVALID',
} as const;

export const MembershipErrorCode = {
  InvalidLevel: 'MEMBERSHIP_INVALID_LEVEL',
  LevelNotHigher: 'MEMBERSHIP_LEVEL_NOT_HIGHER',
  InsufficientPoints: 'MEMBERSHIP_INSUFFICIENT_POINTS',
} as const;

export const CircleErrorCode = {
  MemberLimit: 'CIRCLE_MEMBER_LIMIT',
  AlreadyMember: 'CIRCLE_ALREADY_MEMBER',
  RequestPending: 'CIRCLE_REQUEST_PENDING',
} as const;

export const GroupErrorCode = {
  ManagerOnly: 'GROUP_MANAGER_ONLY',
  OwnerCannotLeave: 'GROUP_OWNER_CANNOT_LEAVE',
  InviteNotAllowed: 'GROUP_INVITE_NOT_ALLOWED',
  ReportNotVerified: 'GROUP_REPORT_NOT_VERIFIED',
  ReportNotActive: 'GROUP_REPORT_NOT_ACTIVE',
  ReportDuplicate: 'GROUP_REPORT_DUPLICATE',
  ReportDescEmpty: 'GROUP_REPORT_DESC_EMPTY',
} as const;

export type AppErrorCode =
  | (typeof AuthErrorCode)[keyof typeof AuthErrorCode]
  | (typeof CoinErrorCode)[keyof typeof CoinErrorCode]
  | (typeof MembershipErrorCode)[keyof typeof MembershipErrorCode]
  | (typeof CircleErrorCode)[keyof typeof CircleErrorCode]
  | (typeof GroupErrorCode)[keyof typeof GroupErrorCode];
