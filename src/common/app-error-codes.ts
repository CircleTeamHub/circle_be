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
  IdempotencyConflict: 'MEMBERSHIP_IDEMPOTENCY_CONFLICT',
  InsufficientPoints: 'MEMBERSHIP_INSUFFICIENT_POINTS',
  UserNotFound: 'MEMBERSHIP_USER_NOT_FOUND',
  // review 修复：幂等键归属/参数不符（跨用户复用、跨等级复用）
  IdempotencyKeyReused: 'MEMBERSHIP_IDEMPOTENCY_KEY_REUSED',
  GroupMemberCapacityExceeded: 'MEMBERSHIP_GROUP_MEMBER_CAPACITY_EXCEEDED',
} as const;

export const AvatarFrameErrorCode = {
  UserNotFound: 'AVATAR_FRAME_USER_NOT_FOUND',
  OperatorNotFound: 'AVATAR_FRAME_OPERATOR_NOT_FOUND',
  AssetNotFound: 'AVATAR_FRAME_ASSET_NOT_FOUND',
  AssetInactive: 'AVATAR_FRAME_ASSET_INACTIVE',
  NotOwned: 'AVATAR_FRAME_NOT_OWNED',
  InvalidExpiry: 'AVATAR_FRAME_INVALID_EXPIRY',
  InvalidReason: 'AVATAR_FRAME_INVALID_REASON',
  InvalidCursor: 'AVATAR_FRAME_INVALID_CURSOR',
  IdempotencyConflict: 'AVATAR_FRAME_IDEMPOTENCY_CONFLICT',
  GrantNotFound: 'AVATAR_FRAME_GRANT_NOT_FOUND',
  AlreadyRevoked: 'AVATAR_FRAME_ALREADY_REVOKED',
} as const;

export const FancyNumberErrorCode = {
  AccountIdLocked: 'FANCY_NUMBER_ACCOUNT_ID_LOCKED',
  InvalidMonths: 'FANCY_NUMBER_INVALID_MONTHS',
  InvalidIdempotencyKey: 'FANCY_NUMBER_INVALID_IDEMPOTENCY_KEY',
  IdempotencyConflict: 'FANCY_NUMBER_IDEMPOTENCY_CONFLICT',
  NotAvailable: 'FANCY_NUMBER_NOT_AVAILABLE',
  AlreadyOwned: 'FANCY_NUMBER_ALREADY_OWNED',
  LeaseNotFound: 'FANCY_NUMBER_LEASE_NOT_FOUND',
  LeaseExpired: 'FANCY_NUMBER_LEASE_EXPIRED',
  PermanentCannotRenew: 'FANCY_NUMBER_PERMANENT_CANNOT_RENEW',
  SwitchRequiresPermanent: 'FANCY_NUMBER_SWITCH_REQUIRES_PERMANENT',
  InvalidValue: 'FANCY_NUMBER_INVALID_VALUE',
  ReservedValue: 'FANCY_NUMBER_RESERVED_VALUE',
  InsufficientPoints: 'FANCY_NUMBER_INSUFFICIENT_POINTS',
  QuoteChanged: 'FANCY_NUMBER_QUOTE_CHANGED',
  InventoryConflict: 'FANCY_NUMBER_INVENTORY_CONFLICT',
  RecommendationLimit: 'FANCY_NUMBER_RECOMMENDATION_LIMIT',
  RecommendationConflict: 'FANCY_NUMBER_RECOMMENDATION_CONFLICT',
  RecommendationNotFound: 'FANCY_NUMBER_RECOMMENDATION_NOT_FOUND',
  RecommendationAccountOccupied: 'FANCY_NUMBER_RECOMMENDATION_ACCOUNT_OCCUPIED',
  RecommendationInvalidOrder: 'FANCY_NUMBER_RECOMMENDATION_INVALID_ORDER',
} as const;

export const CircleErrorCode = {
  MemberLimit: 'CIRCLE_MEMBER_LIMIT',
  // 用户已达到当前会员档位的 ACTIVE 非 OWNER 圈子额度。
  // 当前统一使用圈子域错误码，具体数值由会员目录提供。
  JoinLimitReached: 'CIRCLE_JOIN_LIMIT_REACHED',
  // 同一条上限，但受限的是别人（邀请人邀请他人、圈主审批他人申请）：错误回给
  // 操作者，所以不带 limit / quota / details，客户端文案也另写一句。
  TargetJoinLimitReached: 'CIRCLE_TARGET_JOIN_LIMIT_REACHED',
  // 用户已建满 CIRCLE_CREATE_LIMIT 个圈子。建圈不占加入额度，故需独立上限，
  // 否则建圈路径无界（每个圈子还会连带创建一个 OpenIM 群）。
  CreateLimitReached: 'CIRCLE_CREATE_LIMIT_REACHED',
  AlreadyMember: 'CIRCLE_ALREADY_MEMBER',
  RequestPending: 'CIRCLE_REQUEST_PENDING',
  VipRequired: 'CIRCLE_VIP_REQUIRED',
  NotFound: 'CIRCLE_NOT_FOUND',
  EditForbidden: 'CIRCLE_EDIT_FORBIDDEN',
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
  JoinVipRestrictionExceedsCreator:
    'CIRCLE_JOIN_VIP_RESTRICTION_EXCEEDS_CREATOR',
  ListItemBlank: 'CIRCLE_LIST_ITEM_BLANK',
  ListItemDuplicate: 'CIRCLE_LIST_ITEM_DUPLICATE',
  InvalidCursor: 'CIRCLE_INVALID_CURSOR',
} as const;

export const GroupExpansionErrorCode = {
  ProductNotFound: 'GROUP_EXPANSION_PRODUCT_NOT_FOUND',
  CircleNotFound: 'GROUP_EXPANSION_CIRCLE_NOT_FOUND',
  CapacityExceeded: 'GROUP_EXPANSION_CAPACITY_EXCEEDED',
  InsufficientPoints: 'GROUP_EXPANSION_INSUFFICIENT_POINTS',
  InvalidIdempotencyKey: 'GROUP_EXPANSION_INVALID_IDEMPOTENCY_KEY',
  IdempotencyConflict: 'GROUP_EXPANSION_IDEMPOTENCY_CONFLICT',
  QuoteChanged: 'GROUP_EXPANSION_QUOTE_CHANGED',
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
  VerifierNotFriend: 'INVITATION_VERIFIER_NOT_FRIEND',
  MemberInviteDisabled: 'INVITATION_MEMBER_INVITE_DISABLED',
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
  JoinFailed: 'TEMP_CHAT_JOIN_FAILED',
  UploadQuotaExceeded: 'TEMP_CHAT_UPLOAD_QUOTA_EXCEEDED',
} as const;

// 圈子广场:发帖 / 报名 / 合作认可(战绩)。帖子不存在统一用 PostNotFound;
// 圈子不存在复用 CircleErrorCode.NotFound。图片必须来自本站存储是内部安全护栏,不打码。
export const PlazaErrorCode = {
  MembershipRequired: 'PLAZA_MEMBERSHIP_REQUIRED',
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
  CityFilterQuotaReached: 'CITY_FILTER_QUOTA_REACHED',
  VipRestrictionExceedsAuthor: 'PLAZA_VIP_RESTRICTION_EXCEEDS_AUTHOR',
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
  // 对方开放的「可通过 X 添加我」路径，没有一条对本次请求成立。与
  // FRIEND_STRANGER_MSG_NOT_ALLOWED 分开：那个是「不收陌生人消息」，这个是
  // 「不从这条路径加人」，用户能做的事不一样（后者可以先进同一个圈子）。
  NotDiscoverable: 'FRIEND_NOT_DISCOVERABLE',
} as const;

// 笔记:分组重名/数量上限、导出媒体(无媒体/单文件过大/总量过大/数量过多)。
// 上限类原文含数字,前端用固定文案。
export const NoteErrorCode = {
  StorageQuotaReached: 'NOTE_STORAGE_QUOTA_REACHED',
  GroupExists: 'NOTE_GROUP_EXISTS',
  GroupLimit: 'NOTE_GROUP_LIMIT',
  ExportNoMedia: 'NOTE_EXPORT_NO_MEDIA',
  ExportMediaTooLarge: 'NOTE_EXPORT_MEDIA_TOO_LARGE',
  ExportTotalTooLarge: 'NOTE_EXPORT_TOTAL_TOO_LARGE',
  ExportTooManyMedia: 'NOTE_EXPORT_TOO_MANY_MEDIA',
  NotFound: 'NOTE_NOT_FOUND',
  // round 3：回收站恢复撞上同源活跃收藏副本（唯一索引会拒绝）
  AlreadyCollected: 'NOTE_RESTORE_DUPLICATE',
  GroupNotFound: 'NOTE_GROUP_NOT_FOUND',
  ImageTooLarge: 'NOTE_IMAGE_TOO_LARGE',
  // 分享链接不可用。两处共用：
  // - 访客侧解析：不存在 / 已吊销 / 已过期共用同一个码，避免访客据此区分
  //   「链接从未存在」和「链接曾存在但被吊销」。
  // - 主人侧吊销：链接不存在 / 不属于当前用户，同样共用一个码，不泄漏 id 是否存在。
  // 客户端应按「链接已失效」提示，不要复用笔记的「笔记不存在」文案。
  ShareLinkInvalid: 'NOTE_SHARE_LINK_INVALID',
  ShareLinkInvalidCursor: 'NOTE_SHARE_LINK_INVALID_CURSOR',
  // #94：每用户活跃分享链接达到上限。
  ShareLinkLimit: 'NOTE_SHARE_LINK_LIMIT',
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
  // 1:1 呼叫（#113）：非好友或任一方向已拉黑。共用一个码，不向发起方泄露
  // 「被拉黑」这一事实。
  NotFriend: 'CALL_NOT_FRIEND',
  // 被叫把 callPermission 设成了 NONE。与 CALL_NOT_FRIEND 分开：好友关系还在，
  // 合并成一个码会让发起方以为好友断了、跑去重加。
  PermissionDenied: 'CALL_PERMISSION_DENIED',
} as const;

// 上传:载荷超限。(#96 —— 原为裸英文插值文案直达用户。)
export const UploadErrorCode = {
  PayloadTooLarge: 'UPLOAD_PAYLOAD_TOO_LARGE',
  // 语音/文件类型只对 chat 目录开放(见 UploadService.presign 的目录收口)。
  InvalidContentType: 'UPLOAD_INVALID_CONTENT_TYPE',
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

// 自研聊天(src/chat):REST 与 socket ack 共用同一批码。
// (注:前端 serverErrors 词条随 FE 接线批次补齐。)
export const ChatErrorCode = {
  ConversationNotFound: 'CHAT_CONVERSATION_NOT_FOUND',
  NotMember: 'CHAT_NOT_MEMBER',
  MemberDirectoryForbidden: 'CHAT_MEMBER_DIRECTORY_FORBIDDEN',
  PeerNotFound: 'CHAT_PEER_NOT_FOUND',
  SelfConversation: 'CHAT_SELF_CONVERSATION',
  Blocked: 'CHAT_BLOCKED',
  SensitiveWord: 'CHAT_SENSITIVE_WORD_BLOCKED',
  InvalidPayload: 'CHAT_INVALID_PAYLOAD',
  RateLimited: 'CHAT_RATE_LIMITED',
  ConversationMuted: 'CHAT_CONVERSATION_MUTED',
  StrangerNotAllowed: 'CHAT_STRANGER_NOT_ALLOWED',
  MessageNotFound: 'CHAT_MESSAGE_NOT_FOUND',
  RevokeWindowExpired: 'CHAT_REVOKE_WINDOW_EXPIRED',
  RevokeForbidden: 'CHAT_REVOKE_FORBIDDEN',
  EditWindowExpired: 'CHAT_EDIT_WINDOW_EXPIRED',
  EditForbidden: 'CHAT_EDIT_FORBIDDEN',
  // 独立群聊(不挂圈子的 GROUP):建群/邀请只能选好友;圈子群的成员由圈子管理,
  // 独立群专属操作(邀请/退群/改名)打到圈子群上要显式拒绝而不是静默生效。
  GroupFriendsOnly: 'CHAT_GROUP_FRIENDS_ONLY',
  GroupMinMembers: 'CHAT_GROUP_MIN_MEMBERS',
  GroupCircleManaged: 'CHAT_GROUP_CIRCLE_MANAGED',
  // 扫码进群放开了好友边界,没有容量闸的话一张群码等于无限进人。
  GroupFull: 'CHAT_GROUP_FULL',
} as const;

// 二维码令牌:无效(不存在/已撤销/目标已不可用) / 已过期 / 该类型不支持此操作 /
// 无签发资格(非本人名片、不在群、无圈子邀请权)。
export const QrErrorCode = {
  Invalid: 'QR_INVALID',
  Expired: 'QR_EXPIRED',
  TypeUnsupported: 'QR_TYPE_UNSUPPORTED',
  IssueForbidden: 'QR_ISSUE_FORBIDDEN',
} as const;

// 收藏:收藏项不存在。(注:收藏页暂未接入 getApiErrorMessage,码先就位,待前端接线。)
export const CollectionErrorCode = {
  NotFound: 'COLLECTION_NOT_FOUND',
  // #104 审查发现：无每用户上限，客户端循环可无界造行。
  Limit: 'COLLECTION_LIMIT',
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

// 客服账号配置(管理台写入时的校验)。把「配错了要等用户点击才暴露」提前到配置那一刻。
export const SupportErrorCode = {
  AgentUserNotFound: 'SUPPORT_AGENT_USER_NOT_FOUND',
  AgentUserInactive: 'SUPPORT_AGENT_USER_INACTIVE',
  AgentDuplicate: 'SUPPORT_AGENT_DUPLICATE',
  AgentsConflict: 'SUPPORT_AGENTS_CONFLICT',
} as const;

// 用户资料:仅本人可改 / 仅本人可删 / 生日取值非法。
export const UserErrorCode = {
  UpdateOwnOnly: 'USER_UPDATE_OWN_ONLY',
  DeleteOwnOnly: 'USER_DELETE_OWN_ONLY',
  InvalidBirthday: 'USER_INVALID_BIRTHDAY',
} as const;

export const AdminUserErrorCode = {
  NotFound: 'ADMIN_USER_NOT_FOUND',
  SelfStatusChange: 'ADMIN_USER_SELF_STATUS_CHANGE',
  InvalidStatusTransition: 'ADMIN_USER_INVALID_STATUS_TRANSITION',
  StatusConflict: 'ADMIN_USER_STATUS_CONFLICT',
  ConfirmationMismatch: 'ADMIN_USER_CONFIRMATION_MISMATCH',
  SensitiveFieldInvalid: 'ADMIN_USER_SENSITIVE_FIELD_INVALID',
  SensitiveReasonRequired: 'ADMIN_USER_SENSITIVE_REASON_REQUIRED',
  AuditUnavailable: 'ADMIN_AUDIT_UNAVAILABLE',
} as const;

export type AppErrorCode =
  | (typeof AdminUserErrorCode)[keyof typeof AdminUserErrorCode]
  | (typeof AuthErrorCode)[keyof typeof AuthErrorCode]
  | (typeof CoinErrorCode)[keyof typeof CoinErrorCode]
  | (typeof MembershipErrorCode)[keyof typeof MembershipErrorCode]
  | (typeof AvatarFrameErrorCode)[keyof typeof AvatarFrameErrorCode]
  | (typeof FancyNumberErrorCode)[keyof typeof FancyNumberErrorCode]
  | (typeof CircleErrorCode)[keyof typeof CircleErrorCode]
  | (typeof GroupExpansionErrorCode)[keyof typeof GroupExpansionErrorCode]
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
  | (typeof ChatErrorCode)[keyof typeof ChatErrorCode]
  | (typeof UploadErrorCode)[keyof typeof UploadErrorCode]
  | (typeof CollectionErrorCode)[keyof typeof CollectionErrorCode]
  | (typeof IconErrorCode)[keyof typeof IconErrorCode]
  | (typeof LikeErrorCode)[keyof typeof LikeErrorCode]
  | (typeof PrivacyErrorCode)[keyof typeof PrivacyErrorCode]
  | (typeof SupportErrorCode)[keyof typeof SupportErrorCode]
  | (typeof UserErrorCode)[keyof typeof UserErrorCode]
  | (typeof QrErrorCode)[keyof typeof QrErrorCode];

export const APP_ERROR_CODE_GROUPS = [
  AdminUserErrorCode,
  AuthErrorCode,
  CoinErrorCode,
  MembershipErrorCode,
  AvatarFrameErrorCode,
  FancyNumberErrorCode,
  CircleErrorCode,
  GroupExpansionErrorCode,
  GroupErrorCode,
  CircleInvitationErrorCode,
  TempChatErrorCode,
  PlazaErrorCode,
  TraceErrorCode,
  FriendErrorCode,
  NoteErrorCode,
  CallErrorCode,
  UploadErrorCode,
  ConversationGroupErrorCode,
  ChatHistoryErrorCode,
  ChatErrorCode,
  CollectionErrorCode,
  IconErrorCode,
  LikeErrorCode,
  PrivacyErrorCode,
  SupportErrorCode,
  UserErrorCode,
  QrErrorCode,
] as const;

export const APP_ERROR_CODES = APP_ERROR_CODE_GROUPS.flatMap((group) =>
  Object.values(group),
) as AppErrorCode[];
