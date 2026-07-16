import { BadRequestException, Injectable } from '@nestjs/common';
import { PrivacyErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  MOMENTS_VISIBILITY_OPTIONS,
  PERMISSION_OPTIONS,
  PrivacySettingsDto,
  SELF_DESTRUCT_DAY_OPTIONS,
  UpdatePrivacySettingsDto,
} from './privacy-settings.dto';

const DEFAULT_PRIVACY_SETTINGS: PrivacySettingsDto = {
  messageSelfDestructDays: 2,
  momentsVisibility: 'ALL',
  allowStrangerMessages: true,
  showPhone: false,
  showWechat: true,
  showQQ: true,
  showWhatsup: true,
  addMeByAccount: true,
  addMeByPhone: false,
  addMeByQrCode: true,
  addMeByGroup: true,
  callPermission: 'EVERYONE',
  groupInvitePermission: 'EVERYONE',
};

type StoredPrivacySettings = PrivacySettingsDto & {
  id?: string;
  userID?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

type ProfilePrivacyField = 'phoneNumber' | 'wechat' | 'qq' | 'whatsup';

@Injectable()
export class PrivacySettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings(userId: string): Promise<PrivacySettingsDto> {
    const existing = await this.prisma.userPrivacySetting.findUnique({
      where: { userID: userId },
    });

    if (existing) {
      return this.toDto(existing as StoredPrivacySettings);
    }

    // No row yet → return defaults WITHOUT writing. getSettings is called on
    // every stranger profile view / permission check; lazily creating a row on
    // read would let any viewer trigger a write to the target's row (write
    // amplification). The row is created lazily on the first updateSettings().
    return { ...DEFAULT_PRIVACY_SETTINGS };
  }

  /**
   * Batch variant of {@link getSettings} for callers resolving many users at
   * once (e.g. icon eligibility for a feed page). One query instead of N;
   * users without a row fall back to defaults, matching getSettings.
   */
  async getSettingsForUsers(
    userIds: string[],
  ): Promise<Map<string, PrivacySettingsDto>> {
    const result = new Map<string, PrivacySettingsDto>();
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    if (uniqueIds.length === 0) return result;

    const rows = await this.prisma.userPrivacySetting.findMany({
      where: { userID: { in: uniqueIds } },
    });
    const byUser = new Map(
      rows.map((row) => [
        (row as StoredPrivacySettings).userID as string,
        this.toDto(row as StoredPrivacySettings),
      ]),
    );
    for (const id of uniqueIds) {
      result.set(id, byUser.get(id) ?? { ...DEFAULT_PRIVACY_SETTINGS });
    }
    return result;
  }

  async updateSettings(
    userId: string,
    input: UpdatePrivacySettingsDto,
  ): Promise<PrivacySettingsDto> {
    this.assertValid(input);
    const update = this.compactUpdate(input);
    const saved = await this.prisma.userPrivacySetting.upsert({
      where: { userID: userId },
      create: { userID: userId, ...DEFAULT_PRIVACY_SETTINGS, ...update },
      update,
    });
    return this.toDto(saved as StoredPrivacySettings);
  }

  async canReceiveStrangerMessage(
    targetUserId: string,
    isFriend: boolean,
  ): Promise<boolean> {
    if (isFriend) return true;
    const settings = await this.getSettings(targetUserId);
    return settings.allowStrangerMessages;
  }

  async canViewProfileField(
    targetUserId: string,
    field: ProfilePrivacyField,
    isSelf: boolean,
    isFriend: boolean,
  ): Promise<boolean> {
    if (isSelf) return true;

    const settings = await this.getSettings(targetUserId);
    if (field === 'phoneNumber') return settings.showPhone;
    if (field === 'wechat') return settings.showWechat;
    if (field === 'qq') return settings.showQQ;
    if (field === 'whatsup') return settings.showWhatsup;
    return isFriend;
  }

  async canViewMoments(
    authorUserId: string,
    isSelf: boolean,
    isFriend: boolean,
  ): Promise<boolean> {
    if (isSelf) return true;
    const settings = await this.getSettings(authorUserId);
    return this.momentsVisibleFor(settings, isSelf, isFriend);
  }

  /**
   * Batch variant of getSettings: one query for many users. Users without a row
   * are simply absent from the map; callers fall back to defaults via
   * momentsVisibleFor. Avoids the N+1 that a per-author getSettings loop causes
   * when filtering a whole feed's authors.
   */
  async getSettingsMany(
    userIds: string[],
  ): Promise<Map<string, PrivacySettingsDto>> {
    const byUser = new Map<string, PrivacySettingsDto>();
    if (userIds.length === 0) return byUser;
    const rows = await this.prisma.userPrivacySetting.findMany({
      where: { userID: { in: userIds } },
    });
    for (const row of rows) {
      const stored = row as StoredPrivacySettings;
      byUser.set(stored.userID as string, this.toDto(stored));
    }
    return byUser;
  }

  /**
   * Pure moments-visibility decision over already-loaded settings (or undefined
   * = no row yet → defaults). Shared by canViewMoments and the batch feed path
   * so both apply identical rules.
   */
  momentsVisibleFor(
    settings: PrivacySettingsDto | undefined,
    isSelf: boolean,
    isFriend: boolean,
  ): boolean {
    if (isSelf) return true;
    const visibility =
      settings?.momentsVisibility ?? DEFAULT_PRIVACY_SETTINGS.momentsVisibility;
    if (visibility === 'PRIVATE') return false;
    if (visibility === 'FRIENDS_ONLY') return isFriend;
    return true;
  }

  async canBeInvitedToGroupOrCircle(
    targetUserId: string,
    isFriend: boolean,
  ): Promise<boolean> {
    const settings = await this.getSettings(targetUserId);
    return this.permissionAllows(settings.groupInvitePermission, isFriend);
  }

  async canBeCalled(targetUserId: string, isFriend: boolean): Promise<boolean> {
    const settings = await this.getSettings(targetUserId);
    return this.permissionAllows(settings.callPermission, isFriend);
  }

  private permissionAllows(permission: string, isFriend: boolean) {
    if (permission === 'NONE') return false;
    if (permission === 'FRIENDS_ONLY') return isFriend;
    return true;
  }

  private compactUpdate(input: UpdatePrivacySettingsDto) {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
  }

  private assertValid(input: UpdatePrivacySettingsDto) {
    if (
      input.messageSelfDestructDays !== undefined &&
      !SELF_DESTRUCT_DAY_OPTIONS.includes(input.messageSelfDestructDays)
    ) {
      throw new BadRequestException({
        message: 'Unsupported self-destruct duration',
        errorCode: PrivacyErrorCode.SelfDestructInvalid,
      });
    }
    if (
      input.momentsVisibility !== undefined &&
      !MOMENTS_VISIBILITY_OPTIONS.includes(input.momentsVisibility)
    ) {
      throw new BadRequestException({
        message: 'Unsupported moments visibility',
        errorCode: PrivacyErrorCode.MomentsVisibilityInvalid,
      });
    }
    if (
      input.callPermission !== undefined &&
      !PERMISSION_OPTIONS.includes(input.callPermission)
    ) {
      throw new BadRequestException({
        message: 'Unsupported call permission',
        errorCode: PrivacyErrorCode.CallPermissionInvalid,
      });
    }
    if (
      input.groupInvitePermission !== undefined &&
      !PERMISSION_OPTIONS.includes(input.groupInvitePermission)
    ) {
      throw new BadRequestException({
        message: 'Unsupported invite permission',
        errorCode: PrivacyErrorCode.InvitePermissionInvalid,
      });
    }
  }

  private toDto(settings: StoredPrivacySettings): PrivacySettingsDto {
    return {
      messageSelfDestructDays:
        settings.messageSelfDestructDays ??
        DEFAULT_PRIVACY_SETTINGS.messageSelfDestructDays,
      momentsVisibility:
        settings.momentsVisibility ??
        DEFAULT_PRIVACY_SETTINGS.momentsVisibility,
      allowStrangerMessages:
        settings.allowStrangerMessages ??
        DEFAULT_PRIVACY_SETTINGS.allowStrangerMessages,
      showPhone: settings.showPhone ?? DEFAULT_PRIVACY_SETTINGS.showPhone,
      showWechat: settings.showWechat ?? DEFAULT_PRIVACY_SETTINGS.showWechat,
      showQQ: settings.showQQ ?? DEFAULT_PRIVACY_SETTINGS.showQQ,
      showWhatsup: settings.showWhatsup ?? DEFAULT_PRIVACY_SETTINGS.showWhatsup,
      addMeByAccount:
        settings.addMeByAccount ?? DEFAULT_PRIVACY_SETTINGS.addMeByAccount,
      addMeByPhone:
        settings.addMeByPhone ?? DEFAULT_PRIVACY_SETTINGS.addMeByPhone,
      addMeByQrCode:
        settings.addMeByQrCode ?? DEFAULT_PRIVACY_SETTINGS.addMeByQrCode,
      addMeByGroup:
        settings.addMeByGroup ?? DEFAULT_PRIVACY_SETTINGS.addMeByGroup,
      callPermission:
        settings.callPermission ?? DEFAULT_PRIVACY_SETTINGS.callPermission,
      groupInvitePermission:
        settings.groupInvitePermission ??
        DEFAULT_PRIVACY_SETTINGS.groupInvitePermission,
    };
  }
}
