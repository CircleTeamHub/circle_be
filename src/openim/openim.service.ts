import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const OPENIM_REQUEST_TIMEOUT_MS = 5_000;

@Injectable()
export class OpenimService implements OnModuleInit {
  private readonly logger = new Logger(OpenimService.name);
  private adminToken: string | null = null;
  private adminTokenExpiresAt: number = 0;
  /** In-flight refresh promise — shared across concurrent callers to prevent thundering herd. */
  private adminTokenRefreshPromise: Promise<string> | null = null;

  private readonly apiUrl: string;
  private readonly adminSecret: string;
  private readonly enabled: boolean;

  constructor(private config: ConfigService) {
    this.apiUrl = this.config.get<string>('OPENIM_API_URL') ?? '';
    this.adminSecret = this.config.get<string>('OPENIM_ADMIN_SECRET') ?? '';
    this.enabled = Boolean(this.apiUrl && this.adminSecret);
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn(
        'OpenIM is not configured (OPENIM_API_URL or OPENIM_ADMIN_SECRET missing). IM features will be skipped.',
      );
    }
  }

  // ─── Admin Token ────────────────────────────────────────────────────────────

  private async getAdminToken(): Promise<string> {
    if (this.adminToken && Date.now() < this.adminTokenExpiresAt) {
      return this.adminToken;
    }

    // Return the in-flight promise to all concurrent callers so we only make
    // one refresh request even under a login burst (thundering herd prevention).
    if (this.adminTokenRefreshPromise) {
      return this.adminTokenRefreshPromise;
    }

    this.adminTokenRefreshPromise = this.fetchAdminToken().finally(() => {
      this.adminTokenRefreshPromise = null;
    });
    return this.adminTokenRefreshPromise;
  }

  private async fetchAdminToken(): Promise<string> {
    const res = await this.post<{ token: string }>('/auth/get_admin_token', {
      secret: this.adminSecret,
      platformID: 1,
      userID: 'imAdmin',
    });

    // Cache for 20 hours (tokens typically last 24h)
    this.adminToken = res.token;
    this.adminTokenExpiresAt = Date.now() + 20 * 60 * 60 * 1000;
    return this.adminToken;
  }

  // ─── User ────────────────────────────────────────────────────────────────────

  /**
   * Register a user in OpenIM. Called during business registration.
   * Uses the circle_be User.id (UUID) as the OpenIM userID for 1:1 mapping.
   */
  async registerUser(
    userID: string,
    nickname: string,
    avatarUrl?: string | null,
  ): Promise<void> {
    if (!this.enabled) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/user/user_register',
      {
        users: [
          {
            userID,
            nickname,
            faceURL: avatarUrl ?? '',
          },
        ],
      },
      adminToken,
    );
  }

  /**
   * Get an IM token for a user. Called during business login/register.
   * platformID: 1=iOS, 2=Android, 5=Web
   */
  async getUserToken(userID: string, platformID = 2): Promise<string> {
    if (!this.enabled) return '';

    const adminToken = await this.getAdminToken();
    const res = await this.post<{ token: string }>(
      '/auth/get_user_token',
      { userID, platformID },
      adminToken,
    );
    return res.token;
  }

  // ─── Group (Squad sync) ──────────────────────────────────────────────────────

  async createGroup(
    groupID: string,
    groupName: string,
    ownerUserID: string,
    memberUserIDs: string[] = [],
  ): Promise<void> {
    if (!this.enabled) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/group/create_group',
      {
        memberUserIDs,
        groupInfo: {
          groupID,
          groupName,
          ownerUserID,
          groupType: 2, // 2 = work group
        },
      },
      adminToken,
    );
  }

  async addGroupMembers(groupID: string, userIDs: string[]): Promise<void> {
    if (!this.enabled) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/group/invite_user_to_group',
      { groupID, invitedUserIDs: userIDs, reason: '' },
      adminToken,
    );
  }

  async removeGroupMember(groupID: string, userID: string): Promise<void> {
    if (!this.enabled) return;

    const adminToken = await this.getAdminToken();
    await this.post(
      '/group/kick_group',
      { groupID, kickedUserIDs: [userID], reason: '' },
      adminToken,
    );
  }

  // ─── HTTP helper ─────────────────────────────────────────────────────────────

  private async post<T = void>(
    path: string,
    body: Record<string, unknown>,
    token?: string,
  ): Promise<T> {
    const { randomUUID } = await import('crypto');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Use UUID so concurrent requests each get a unique trace ID in OpenIM logs.
      operationID: randomUUID(),
    };
    if (token) {
      headers['token'] = token;
    }

    const response = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OPENIM_REQUEST_TIMEOUT_MS),
    });

    const json = (await response.json()) as {
      errCode: number;
      errMsg?: string;
      data?: T;
    };

    if (json.errCode !== 0) {
      this.logger.error(
        `OpenIM API error [${path}]: ${json.errMsg ?? json.errCode}`,
      );
      throw new Error(`OpenIM error: ${json.errMsg ?? json.errCode}`);
    }

    return json.data as T;
  }
}
