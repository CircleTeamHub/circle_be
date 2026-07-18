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
  InviteCodeInvalid: 'AUTH_INVITE_CODE_INVALID',
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
  InvalidCursor: 'CIRCLE_INVALID_CURSOR',
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

// 圈子邀请 / 10 人担保流程。入圈限制(VIP / 信用分 / 靓号)与「已是成员 / 圈子已满 /
// 用户不存在」复用上面的 CircleErrorCode,这里只列邀请流程独有的错误。
export const CircleInvitationErrorCode = {
  InviterNotMember: 'INVITATION_INVITER_NOT_MEMBER',
  NotAllowed: 'INVITATION_NOT_ALLOWED',
  AlreadyPending: 'INVITATION_ALREADY_PENDING',
  NotFound: 'INVITATION_NOT_FOUND',
  ApplicantOnly: 'INVITATION_APPLICANT_ONLY',
  NotPending: 'INVITATION_NOT_PENDING',
  VerifierNotMember: 'INVITATION_VERIFIER_NOT_MEMBER',
  AlreadyVerifier: 'INVITATION_ALREADY_VERIFIER',
  SlotsFilled: 'INVITATION_SLOTS_FILLED',
  NoPendingVerification: 'INVITATION_NO_PENDING_VERIFICATION',
  OwnerAdminOnly: 'INVITATION_OWNER_ADMIN_ONLY',
  ViewForbidden: 'INVITATION_VIEW_FORBIDDEN',
  InvalidCursor: 'INVITATION_INVALID_CURSOR',
} as const;

// 临时聊天(访客免注册)。链接失效 / 已结束 / 人数已满面向 H5 访客页,
// 仅创建者可结束面向 App 内 TempChatsScreen。
export const TempChatErrorCode = {
  LinkInvalid: 'TEMP_CHAT_LINK_INVALID',
  Ended: 'TEMP_CHAT_ENDED',
  Full: 'TEMP_CHAT_FULL',
  CreatorOnly: 'TEMP_CHAT_CREATOR_ONLY',
} as const;

// 圈子广场:发帖 / 报名 / 合作认可(战绩)。帖子不存在统一用 PostNotFound;
// 圈子不存在复用 CircleErrorCode.NotFound。图片必须来自本站存储是内部安全护栏,不打码。
export const PlazaErrorCode = {
  NotActiveMember: 'PLAZA_NOT_ACTIVE_MEMBER',
  AdminOnlyPost: 'PLAZA_ADMIN_ONLY_POST',
  NoteInvalid: 'PLAZA_NOTE_INVALID',
  PostNotFound: 'PLAZA_POST_NOT_FOUND',
  DeleteAuthorOnly: 'PLAZA_DELETE_AUTHOR_ONLY',
  SignupSelf: 'PLAZA_SIGNUP_SELF',
  SignupIneligible: 'PLAZA_SIGNUP_INELIGIBLE',
  RecognizeMinOne: 'PLAZA_RECOGNIZE_MIN_ONE',
  RecognizeMaxThree: 'PLAZA_RECOGNIZE_MAX_THREE',
  RecognizeSelf: 'PLAZA_RECOGNIZE_SELF',
  RecognizeMinSignups: 'PLAZA_RECOGNIZE_MIN_SIGNUPS',
  RecognizeNotSigned: 'PLAZA_RECOGNIZE_NOT_SIGNED',
  RecognizeNotMember: 'PLAZA_RECOGNIZE_NOT_MEMBER',
  RecognizeBlocked: 'PLAZA_RECOGNIZE_BLOCKED',
  RecognizeAlready: 'PLAZA_RECOGNIZE_ALREADY',
  ReportSelf: 'PLAZA_REPORT_SELF',
  NotCircleMember: 'PLAZA_NOT_CIRCLE_MEMBER',
  InvalidCursor: 'PLAZA_INVALID_CURSOR',
} as const;

// 朋友圈动态(moments):动态/评论不存在、仅作者可删、无权访问(隐私/好友可见)。
export const TraceErrorCode = {
  MomentNotFound: 'TRACE_MOMENT_NOT_FOUND',
  DeleteAuthorOnly: 'TRACE_DELETE_AUTHOR_ONLY',
  ReplyTargetNotFound: 'TRACE_REPLY_TARGET_NOT_FOUND',
  CommentNotFound: 'TRACE_COMMENT_NOT_FOUND',
  AccessForbidden: 'TRACE_ACCESS_FORBIDDEN',
  ReplyTargetMismatch: 'TRACE_REPLY_TARGET_MISMATCH',
  InvalidCursor: 'TRACE_INVALID_CURSOR',
  EmptyComment: 'TRACE_EMPTY_COMMENT',
} as const;

// 好友:加好友 / 申请处理 / 拉黑 / 举报 / 好友标签。好友数、标签数上限原文含数字,
// 但信封不透传插值参数,前端用不带数字的固定文案。
export const FriendErrorCode = {
  SelfAdd: 'FRIEND_SELF_ADD',
  UserNotFound: 'FRIEND_USER_NOT_FOUND',
  BlockedCannotRequest: 'FRIEND_BLOCKED_CANNOT_REQUEST',
  StrangerMsgNotAllowed: 'FRIEND_STRANGER_MSG_NOT_ALLOWED',
  AlreadyFriends: 'FRIEND_ALREADY_FRIENDS',
  RequestAlreadyPending: 'FRIEND_REQUEST_ALREADY_PENDING',
  PendingRequestNotFound: 'FRIEND_PENDING_REQUEST_NOT_FOUND',
  RequesterUnavailable: 'FRIEND_REQUESTER_UNAVAILABLE',
  FriendshipNotFound: 'FRIEND_FRIENDSHIP_NOT_FOUND',
  ReportSelf: 'FRIEND_REPORT_SELF',
  ReportDuplicate: 'FRIEND_REPORT_DUPLICATE',
  BlockSelf: 'FRIEND_BLOCK_SELF',
  AlreadyBlocked: 'FRIEND_ALREADY_BLOCKED',
  TagNotFound: 'FRIEND_TAG_NOT_FOUND',
  TagLimitReached: 'FRIEND_TAG_LIMIT_REACHED',
  LimitReached: 'FRIEND_LIMIT_REACHED',
  ActivityNotFound: 'FRIEND_ACTIVITY_NOT_FOUND',
  BlockNotFound: 'FRIEND_BLOCK_NOT_FOUND',
  TagNameEmpty: 'FRIEND_TAG_NAME_EMPTY',
  RequestMessageInvalid: 'FRIEND_REQUEST_MESSAGE_INVALID',
  RequestMessageLimit: 'FRIEND_REQUEST_MESSAGE_LIMIT',
  RequestNotPending: 'FRIEND_REQUEST_NOT_PENDING',
  RequestAlreadyHandled: 'FRIEND_REQUEST_ALREADY_HANDLED',
} as const;

// 笔记:分组重名/数量上限、导出媒体(无媒体/单文件过大/总量过大/数量过多)。
// 上限类原文含数字,前端用固定文案。
export const NoteErrorCode = {
  GroupExists: 'NOTE_GROUP_EXISTS',
  GroupLimit: 'NOTE_GROUP_LIMIT',
  ExportNoMedia: 'NOTE_EXPORT_NO_MEDIA',
  ExportMediaTooLarge: 'NOTE_EXPORT_MEDIA_TOO_LARGE',
  ExportTotalTooLarge: 'NOTE_EXPORT_TOTAL_TOO_LARGE',
  ExportTooManyMedia: 'NOTE_EXPORT_TOO_MANY_MEDIA',
  NotFound: 'NOTE_NOT_FOUND',
  GroupNotFound: 'NOTE_GROUP_NOT_FOUND',
  ImageTooLarge: 'NOTE_IMAGE_TOO_LARGE',
  // 分享链接不可用。两处共用：
  // - 访客侧解析：不存在 / 已吊销 / 已过期共用同一个码，避免访客据此区分
  //   「链接从未存在」和「链接曾存在但被吊销」。
  // - 主人侧吊销：链接不存在 / 不属于当前用户，同样共用一个码，不泄漏 id 是否存在。
  // 客户端应按「链接已失效」提示，不要复用笔记的「笔记不存在」文案。
  ShareLinkInvalid: 'NOTE_SHARE_LINK_INVALID',
} as const;

// 实时通话:会在通话 UI 弹给用户的错误。
// 其余信令竞态、LiveKit 基建错误走通用兜底。原 message 本就是 CALL_* 机器串,保留。
export const CallErrorCode = {
  Ended: 'CALL_ENDED',
  Expired: 'CALL_EXPIRED',
  Busy: 'CALL_BUSY',
  NotGroupMember: 'CALL_NOT_GROUP_MEMBER',
  ParticipantLimit: 'CALL_PARTICIPANT_LIMIT',
  InviteesRequired: 'CALL_INVITEES_REQUIRED',
  InviteeInvalid: 'CALL_INVITEE_INVALID',
  NotAccepted: 'CALL_NOT_ACCEPTED',
  VideoDisabled: 'CALL_VIDEO_DISABLED',
  NotInvited: 'CALL_NOT_INVITED',
  NotFound: 'CALL_NOT_FOUND',
  NotAllowed: 'CALL_NOT_ALLOWED',
  AlreadyActive: 'CALL_ALREADY_ACTIVE',
} as const;

// 会话分组(本地消息分组):同名分组已存在 / 分组不存在。
export const ConversationGroupErrorCode = {
  NameTaken: 'CONVGROUP_NAME_TAKEN',
  NotFound: 'CONVGROUP_NOT_FOUND',
} as const;

// 会话历史(按日期查看聊天记录):会话不存在。
export const ChatHistoryErrorCode = {
  ConversationNotFound: 'CHAT_HISTORY_CONVERSATION_NOT_FOUND',
} as const;

// 收藏:收藏项不存在。(注:收藏页暂未接入 getApiErrorMessage,码先就位,待前端接线。)
export const CollectionErrorCode = {
  NotFound: 'COLLECTION_NOT_FOUND',
} as const;

// 展示图标 / 系统图标 / 圈子图标选择。(注:图标页暂未接入 getApiErrorMessage,待前端接线。)
export const IconErrorCode = {
  DisplayLimit: 'ICON_DISPLAY_LIMIT',
  InvalidSystemSelection: 'ICON_INVALID_SYSTEM_SELECTION',
  InvalidCircleSelection: 'ICON_INVALID_CIRCLE_SELECTION',
  DuplicateSelection: 'ICON_DUPLICATE_SELECTION',
} as const;

// 点赞:自赞 / 目标不可用 / 每日上限 / 频率过高。(注:点赞入口暂未接入 getApiErrorMessage,待前端接线。)
export const LikeErrorCode = {
  SelfLike: 'LIKE_SELF',
  TargetUnavailable: 'LIKE_TARGET_UNAVAILABLE',
  DailyLimit: 'LIKE_DAILY_LIMIT',
  TooFrequent: 'LIKE_TOO_FREQUENT',
} as const;

// 隐私设置:阅后即焚时长 / 动态可见范围 / 通话权限 / 邀请权限 取值非法。
export const PrivacyErrorCode = {
  SelfDestructInvalid: 'PRIVACY_SELF_DESTRUCT_INVALID',
  MomentsVisibilityInvalid: 'PRIVACY_MOMENTS_VISIBILITY_INVALID',
  CallPermissionInvalid: 'PRIVACY_CALL_PERMISSION_INVALID',
  InvitePermissionInvalid: 'PRIVACY_INVITE_PERMISSION_INVALID',
} as const;

// 用户资料:仅本人可改 / 仅本人可删 / 生日取值非法。
export const UserErrorCode = {
  UpdateOwnOnly: 'USER_UPDATE_OWN_ONLY',
  DeleteOwnOnly: 'USER_DELETE_OWN_ONLY',
  InvalidBirthday: 'USER_INVALID_BIRTHDAY',
} as const;

export type AppErrorCode =
  | (typeof AuthErrorCode)[keyof typeof AuthErrorCode]
  | (typeof CoinErrorCode)[keyof typeof CoinErrorCode]
  | (typeof MembershipErrorCode)[keyof typeof MembershipErrorCode]
  | (typeof CircleErrorCode)[keyof typeof CircleErrorCode]
  | (typeof GroupErrorCode)[keyof typeof GroupErrorCode]
  | (typeof CircleInvitationErrorCode)[keyof typeof CircleInvitationErrorCode]
  | (typeof TempChatErrorCode)[keyof typeof TempChatErrorCode]
  | (typeof PlazaErrorCode)[keyof typeof PlazaErrorCode]
  | (typeof TraceErrorCode)[keyof typeof TraceErrorCode]
  | (typeof FriendErrorCode)[keyof typeof FriendErrorCode]
  | (typeof NoteErrorCode)[keyof typeof NoteErrorCode]
  | (typeof CallErrorCode)[keyof typeof CallErrorCode]
  | (typeof ConversationGroupErrorCode)[keyof typeof ConversationGroupErrorCode]
  | (typeof ChatHistoryErrorCode)[keyof typeof ChatHistoryErrorCode]
  | (typeof CollectionErrorCode)[keyof typeof CollectionErrorCode]
  | (typeof IconErrorCode)[keyof typeof IconErrorCode]
  | (typeof LikeErrorCode)[keyof typeof LikeErrorCode]
  | (typeof PrivacyErrorCode)[keyof typeof PrivacyErrorCode]
  | (typeof UserErrorCode)[keyof typeof UserErrorCode];

export const APP_ERROR_CODE_GROUPS = [
  AuthErrorCode,
  CoinErrorCode,
  MembershipErrorCode,
  CircleErrorCode,
  GroupErrorCode,
  CircleInvitationErrorCode,
  TempChatErrorCode,
  PlazaErrorCode,
  TraceErrorCode,
  FriendErrorCode,
  NoteErrorCode,
  CallErrorCode,
  ConversationGroupErrorCode,
  ChatHistoryErrorCode,
  CollectionErrorCode,
  IconErrorCode,
  LikeErrorCode,
  PrivacyErrorCode,
  UserErrorCode,
] as const;

export const APP_ERROR_CODES = APP_ERROR_CODE_GROUPS.flatMap((group) =>
  Object.values(group),
) as AppErrorCode[];
