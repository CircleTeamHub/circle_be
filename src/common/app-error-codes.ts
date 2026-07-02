// 前后端共享的稳定错误码。抛异常时用 `throw new XException({ message, errorCode })`,
// all-exception.filter 会把 errorCode 透传进响应信封;前端按 code 映射本地化文案
// (i18n `serverErrors.<code>`),未知 code 在新版 App 中回落通用错误文案。
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
  // 以下补齐同属认证/账号安全流、原本仍抛中文裸串的关键路径,
  // 避免非中文用户在改密码 / 改账号 / 安全码校验等流程看到中文兜底。
  SecurityCodeFormat: 'AUTH_SECURITY_CODE_FORMAT',
  PasswordIncorrect: 'AUTH_PASSWORD_INCORRECT',
  AccountDisabled: 'AUTH_ACCOUNT_DISABLED',
  AccountIdUnchanged: 'AUTH_ACCOUNT_ID_UNCHANGED',
  AccountIdInvalid: 'AUTH_ACCOUNT_ID_INVALID',
  CodeRateLimited: 'AUTH_CODE_RATE_LIMITED',
  UserNotFound: 'AUTH_USER_NOT_FOUND',
} as const;

export const CoinErrorCode = {
  SelfTransfer: 'COIN_SELF_TRANSFER',
  NotFriend: 'COIN_NOT_FRIEND',
  Insufficient: 'COIN_INSUFFICIENT',
  AmountInvalid: 'COIN_AMOUNT_INVALID',
  AmountTooLarge: 'COIN_AMOUNT_TOO_LARGE',
  DailyLimit: 'COIN_DAILY_LIMIT',
  RecipientNotFound: 'COIN_RECIPIENT_NOT_FOUND',
  UserNotFound: 'COIN_USER_NOT_FOUND',
} as const;

export const MembershipErrorCode = {
  InvalidLevel: 'MEMBERSHIP_INVALID_LEVEL',
  LevelNotHigher: 'MEMBERSHIP_LEVEL_NOT_HIGHER',
  InsufficientPoints: 'MEMBERSHIP_INSUFFICIENT_POINTS',
  UserNotFound: 'MEMBERSHIP_USER_NOT_FOUND',
} as const;

export const CircleErrorCode = {
  MemberLimit: 'CIRCLE_MEMBER_LIMIT',
  AlreadyMember: 'CIRCLE_ALREADY_MEMBER',
  RequestPending: 'CIRCLE_REQUEST_PENDING',
  VipRequired: 'CIRCLE_VIP_REQUIRED',
  NotFound: 'CIRCLE_NOT_FOUND',
  NotMember: 'CIRCLE_NOT_MEMBER',
  UserNotFound: 'CIRCLE_USER_NOT_FOUND',
  IconAssetNotFound: 'CIRCLE_ICON_ASSET_NOT_FOUND',
  IconOwnerOnly: 'CIRCLE_ICON_OWNER_ONLY',
  AvatarUrlInvalid: 'CIRCLE_AVATAR_URL_INVALID',
  AlreadyMemberOrPending: 'CIRCLE_ALREADY_MEMBER_OR_PENDING',
  OwnerCannotLeave: 'CIRCLE_OWNER_CANNOT_LEAVE',
  JoinVipRequired: 'CIRCLE_JOIN_VIP_REQUIRED',
  JoinCreditRequired: 'CIRCLE_JOIN_CREDIT_REQUIRED',
  JoinFancyNumberRequired: 'CIRCLE_JOIN_FANCY_NUMBER_REQUIRED',
  ListItemBlank: 'CIRCLE_LIST_ITEM_BLANK',
  ListItemDuplicate: 'CIRCLE_LIST_ITEM_DUPLICATE',
} as const;

export const GroupErrorCode = {
  ManagerOnly: 'GROUP_MANAGER_ONLY',
  OwnerCannotLeave: 'GROUP_OWNER_CANNOT_LEAVE',
  InviteNotAllowed: 'GROUP_INVITE_NOT_ALLOWED',
  ReportNotVerified: 'GROUP_REPORT_NOT_VERIFIED',
  ReportNotActive: 'GROUP_REPORT_NOT_ACTIVE',
  ReportDuplicate: 'GROUP_REPORT_DUPLICATE',
  ReportDescEmpty: 'GROUP_REPORT_DESC_EMPTY',
  NotFound: 'GROUP_NOT_FOUND',
  MemberNotFound: 'GROUP_MEMBER_NOT_FOUND',
  UseLeaveEndpoint: 'GROUP_USE_LEAVE_ENDPOINT',
  MembershipVerifyUnavailable: 'GROUP_MEMBERSHIP_VERIFY_UNAVAILABLE',
} as const;

export type AppErrorCode =
  | (typeof AuthErrorCode)[keyof typeof AuthErrorCode]
  | (typeof CoinErrorCode)[keyof typeof CoinErrorCode]
  | (typeof MembershipErrorCode)[keyof typeof MembershipErrorCode]
  | (typeof CircleErrorCode)[keyof typeof CircleErrorCode]
  | (typeof GroupErrorCode)[keyof typeof GroupErrorCode];

export const APP_ERROR_CODE_GROUPS = [
  AuthErrorCode,
  CoinErrorCode,
  MembershipErrorCode,
  CircleErrorCode,
  GroupErrorCode,
] as const;

export const APP_ERROR_CODES = APP_ERROR_CODE_GROUPS.flatMap((group) =>
  Object.values(group),
) as AppErrorCode[];
