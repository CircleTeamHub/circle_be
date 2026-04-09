import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { GetUserDto } from './dto/get-user.dto';
import { Gender, UserStatus } from 'src/generated/prisma';

const URL_FIELDS: (keyof UpdateUserInput)[] = [
  'avatarUrl',
  'avatarFrame',
  'cover',
];

export interface CreateUserInput {
  accountId: string;
  password: string;
  nickname?: string;
  email?: string;
  phoneNumber?: string;
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

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return new Date(`${normalized}T00:00:00.000Z`);
  }

  return new Date(normalized);
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
  ) {
    this.minioPublicUrl = this.config.get<string>('MINIO_PUBLIC_URL') ?? null;
  }

  /**
   * Rejects URL fields that don't originate from our own storage.
   * Prevents SSRF-capable URLs (cloud metadata, localhost, javascript:, data:)
   * being stored and later rendered by clients.
   *
   * When MinIO is not configured we skip the check — upload is disabled anyway.
   */
  private assertUrlsAreSafe(input: UpdateUserInput): void {
    if (!this.minioPublicUrl) return;

    const prefix = this.minioPublicUrl.replace(/\/$/, '');
    for (const field of URL_FIELDS) {
      const value = input[field as keyof UpdateUserInput];
      if (typeof value === 'string' && !value.startsWith(prefix)) {
        throw new BadRequestException(
          `${field} must be a URL served from this application's storage`,
        );
      }
    }
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

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: PUBLIC_SELECT,
    });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  async create(input: CreateUserInput) {
    const passwordHash = await argon2.hash(input.password);

    return this.prisma.user.create({
      data: {
        accountId: input.accountId,
        passwordHash,
        nickname: input.nickname || input.accountId,
        email: input.email,
        phoneNumber: input.phoneNumber,
      },
      select: PUBLIC_SELECT,
    });
  }

  async update(id: string, input: UpdateUserInput) {
    this.assertUrlsAreSafe(input);
    await this.findOne(id);
    return this.prisma.user.update({
      where: { id },
      data: normalizeUpdateInput(input),
      select: PUBLIC_SELECT,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.user.update({
      where: { id },
      data: { status: UserStatus.DELETED },
      select: PUBLIC_SELECT,
    });
  }

  async updateStatus(id: string, status: UserStatus) {
    await this.findOne(id);
    return this.prisma.user.update({
      where: { id },
      data: { status },
      select: PUBLIC_SELECT,
    });
  }
}
