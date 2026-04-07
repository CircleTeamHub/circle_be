import { Injectable, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from 'src/prisma/prisma.service';
import { generateAccountId } from 'src/utils/account-id';
import { GetUserDto } from './dto/get-user.dto';
import { Gender, UserStatus } from 'src/generated/prisma';

export interface CreateUserInput {
  username: string;
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
  birthday?: string;
  gender?: Gender;
}

const PUBLIC_SELECT = {
  id: true,
  accountId: true,
  username: true,
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

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: GetUserDto) {
    const { limit = 10, page = 1, username } = query;
    const take = limit;
    const skip = (page - 1) * take;
    const where = username ? { username: { contains: username } } : undefined;

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
    const accountId = generateAccountId();

    return this.prisma.user.create({
      data: {
        accountId,
        username: input.username,
        passwordHash,
        nickname: input.nickname || input.username,
        email: input.email,
        phoneNumber: input.phoneNumber,
      },
      select: PUBLIC_SELECT,
    });
  }

  async update(id: string, input: UpdateUserInput) {
    await this.findOne(id);
    return this.prisma.user.update({
      where: { id },
      data: input,
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
