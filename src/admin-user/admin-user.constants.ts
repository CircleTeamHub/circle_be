export const SENSITIVE_FIELDS = [
  'email',
  'phoneNumber',
  'wechat',
  'qq',
  'whatsup',
] as const;

export type SensitiveField = (typeof SENSITIVE_FIELDS)[number];

export const AdminAuditAction = {
  SensitiveFieldViewed: 'USER_SENSITIVE_FIELD_VIEWED',
  UserBanned: 'USER_BANNED',
  UserUnbanned: 'USER_UNBANNED',
  UserDeleted: 'USER_DELETED',
} as const;
