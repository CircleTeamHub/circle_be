import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { RefreshTokenService } from 'src/auth/refresh-token.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { assertUrlsFromStorage } from 'src/utils/storage-url';
import { GetUserDto } from './dto/get-user.dto';
import { Gender, UserStatus } from 'src/generated/prisma';
import { IconService } from 'src/icon/icon.service';

const URL_FIELDS: (keyof UpdateUserInput)[] = [
  'avatarUrl',
  'avatarFrame',
  'cover',
];

export interface CreateUserInput {
  accountId: string;
  password: string;
  nickname?: string;
}

export interface UpdateUserInput {
  nickname?: string;
  avatarUrl?: string;
  avatarFrame?: string;
  cover?: string;
  email?: string;
  phoneNumber?: string;
  wechat?: string;
  qq?: string;
  whatsup?: string;
  persona?: string;
  helloWords?: string;
  birthday?: string | null;
  gender?: Gender;
  city?: string | null;
  region?: string | null;
}

const PUBLIC_SELECT = {
  id: true,
  accountId: true,
  nickname: true,
  avatarUrl: true,
  avatarFrame: true,
  cover: true,
  email: true,
  phoneNumber: true,
  wechat: true,
  qq: true,
  whatsup: true,
  persona: true,
  helloWords: true,
  birthday: true,
  gender: true,
  city: true,
  region: true,
  role: true,
  status: true,
  lastOnline: true,
  createdAt: true,
  updatedAt: true,
} as const;

function normalizeBirthdayInput(value: string | null | undefined) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const normalized = value.trim();

  if (!normalized) {
    return null;
  }

  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? new Date(`${normalized}T00:00:00.000Z`)
    : new Date(normalized);

  if (Number.isNaN(parsed.getTime())) {
    // The DTO's @IsDateString validator should already reject this, but the
    // service is also called from places that bypass the pipe (e.g. internal
    // jobs); fail fast instead of letting an Invalid Date hit Prisma.
    throw new BadRequestException(`Invalid birthday value: ${value}`);
  }

  return parsed;
}

function normalizeUpdateInput(input: UpdateUserInput) {
  if (!('birthday' in input)) {
    return input;
  }

  return {
    ...input,
    birthday: normalizeBirthdayInput(input.birthday),
  };
}

@Injectable()
export class UserService {
  private readonly minioPublicUrl: string | null;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private refreshTokens: RefreshTokenService,
    private iconService: IconService,
    private realtimeService: RealtimeService,
  ) {
    this.minioPublicUrl = this.config.get<string>('MINIO_PUBLIC_URL') ?? null;
  }

  /**
   * Rejects URL fields that don't originate from our own storage.
   * Prevents SSRF-capable URLs (cloud metadata, localhost, javascript:, data:)
   * being stored and later rendered by clients.
   *
   * Delegates to the shared `assertUrlsFromStorage` guard — which closes the
   * `host.attacker.com` bypass that the previous bare `startsWith` allowed.
   */
  private assertUrlsAreSafe(input: UpdateUserInput): void {
    assertUrlsFromStorage(
      URL_FIELDS.map((field) => input[field] as string | undefined),
      this.minioPublicUrl,
      'profile image url',
    );
  }

  async findAll(query: GetUserDto) {
    const { limit = 10, page = 1, accountId } = query;
    const take = limit;
    const skip = (page - 1) * take;
    const where = accountId
      ? { accountId: { contains: accountId } }
      : undefined;

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({ where, select: PUBLIC_SELECT, take, skip }),
      this.prisma.user.count({ where }),
    ]);

    return { data, total, page, limit: take };
  }

  async findByExactAccountId(accountId: string | undefined) {
    if (!accountId) return null;
    const normalized = accountId.trim();

    if (!normalized) {
      return null;
    }

    return this.prisma.user.findFirst({
      where: {
        accountId: {
          equals: normalized,
          mode: 'insensitive',
        },
        status: 'ACTIVE',
      },
      select: PUBLIC_SELECT,
    });
  }

  async findOne(id: string) {
    const [user, displayIcons] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id },
        select: PUBLIC_SELECT,
      }),
      this.iconService.getDisplayIconsForUser(id),
    ]);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return {
      ...user,
      displayIcons,
    };
  }

  async create(input: CreateUserInput) {
    const passwordHash = await argon2.hash(input.password);

    return this.prisma.user.create({
      data: {
        accountId: input.accountId,
        passwordHash,
        nickname: input.nickname || input.accountId,
      },
      select: PUBLIC_SELECT,
    });
  }

  async update(id: string, input: UpdateUserInput) {
    this.assertUrlsAreSafe(input);
    await this.findOne(id);
    const [user, displayIcons] = await Promise.all([
      this.prisma.user.update({
        where: { id },
        data: normalizeUpdateInput(input),
        select: PUBLIC_SELECT,
      }),
      this.iconService.getDisplayIconsForUser(id),
    ]);
    await this.realtimeService.broadcastUserProfileSummary(id);
    return {
      ...user,
      displayIcons,
    };
  }

  async remove(id: string) {
    await this.findOne(id);
    const [user, displayIcons] = await Promise.all([
      this.prisma.user.update({
        where: { id },
        data: { status: UserStatus.DELETED },
        select: PUBLIC_SELECT,
      }),
      this.iconService.getDisplayIconsForUser(id),
    ]);
    // A deleted user must lose every active session; otherwise an attacker
    // (or the user themselves) can keep refreshing tokens for up to 7 days.
    await this.refreshTokens.revokeAll(id);
    return {
      ...user,
      displayIcons,
    };
  }

  async updateStatus(id: string, status: UserStatus) {
    await this.findOne(id);
    const [user, displayIcons] = await Promise.all([
      this.prisma.user.update({
        where: { id },
        data: { status },
        select: PUBLIC_SELECT,
      }),
      this.iconService.getDisplayIconsForUser(id),
    ]);
    // BAN / DELETE must invalidate sessions immediately. ACTIVE → ACTIVE is a
    // no-op revoke call; cheaper than introducing a branch.
    if (status !== UserStatus.ACTIVE) {
      await this.refreshTokens.revokeAll(id);
    }
    await this.realtimeService.broadcastUserProfileSummary(id);
    return {
      ...user,
      displayIcons,
    };
  }

  async updateBasicProfile(id: string, input: UpdateUserInput) {
    // Same storage-origin guard as `update` — an off-origin avatarUrl/cover
    // would otherwise become a stored tracking / phishing vector.
    this.assertUrlsAreSafe(input);
    const user = await this.prisma.user.update({
      where: { id },
      data: normalizeUpdateInput(input),
      select: PUBLIC_SELECT,
    });
    await this.realtimeService.broadcastUserProfileSummary(id);
    return user;
  }
}
