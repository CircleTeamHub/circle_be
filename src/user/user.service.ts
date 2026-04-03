import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from 'src/prisma/prisma.service';
import { generateAccountId } from 'src/utils/account-id';
import { GetUserDto } from './dto/get-user.dto';

export interface CreateUserInput {
  username: string;
  password: string;
  nickname?: string;
}

export interface UpdateUserInput {
  nickname?: string;
  avatarUrl?: string;
}

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  findAll(query: GetUserDto) {
    const { limit, page, username } = query;
    const take = limit || 10;
    const skip = ((page || 1) - 1) * take;

    return this.prisma.user.findMany({
      where: username ? { username: { contains: username } } : undefined,
      select: {
        id: true,
        accountId: true,
        username: true,
        nickname: true,
        avatarUrl: true,
        status: true,
        createdAt: true,
      },
      take,
      skip,
    });
  }

  find(username: string) {
    return this.prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        accountId: true,
        username: true,
        nickname: true,
        avatarUrl: true,
        status: true,
        createdAt: true,
      },
    });
  }

  findOne(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        accountId: true,
        username: true,
        nickname: true,
        avatarUrl: true,
        status: true,
        createdAt: true,
      },
    });
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
      },
      select: {
        id: true,
        accountId: true,
        username: true,
        nickname: true,
        avatarUrl: true,
        status: true,
        createdAt: true,
      },
    });
  }

  update(id: string, input: UpdateUserInput) {
    return this.prisma.user.update({
      where: { id },
      data: input,
      select: {
        id: true,
        accountId: true,
        username: true,
        nickname: true,
        avatarUrl: true,
        status: true,
        updatedAt: true,
      },
    });
  }

  remove(id: string) {
    return this.prisma.user.delete({
      where: { id },
      select: {
        id: true,
        accountId: true,
        username: true,
        nickname: true,
        avatarUrl: true,
        status: true,
        createdAt: true,
      },
    });
  }

  findProfile(id: string) {
    return this.findOne(id);
  }

  // Logs not yet implemented — returns empty array until logs module is scoped in
  findUserLogs(_id: string) {
    return Promise.resolve([]);
  }

  findLogsByGroup(_id: string) {
    return Promise.resolve([]);
  }
}
