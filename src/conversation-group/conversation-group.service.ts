import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { ConversationGroupErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  ConversationGroupDto,
  CreateConversationGroupDto,
  SetConversationGroupMembersDto,
  UpdateConversationGroupDto,
} from './dto/conversation-group.dto';

type ConversationGroupWithMemberships = Prisma.ConversationGroupGetPayload<{
  include: { memberships: true };
}>;

const MAX_GROUPS_PER_USER = 200;

@Injectable()
export class ConversationGroupService {
  constructor(private readonly prisma: PrismaService) {}

  private toDto(group: ConversationGroupWithMemberships): ConversationGroupDto {
    return {
      id: group.id,
      name: group.name,
      sortOrder: group.sortOrder,
      pinnedToTabs: group.pinnedToTabs,
      conversationIDs: group.memberships
        .map((m) => m.conversationID)
        .sort((a, b) => a.localeCompare(b)), // stable order so clients can diff cheaply
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
    };
  }

  async list(ownerID: string): Promise<ConversationGroupDto[]> {
    const groups = await this.prisma.conversationGroup.findMany({
      where: { ownerID },
      include: { memberships: true },
      // v1: 按 createdAt 排；sortOrder 字段为 v2 拖拽预留。
      // 仍然 prefer sortOrder asc 然后 createdAt asc 作 tiebreaker，未来切换无需迁移数据。
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      take: MAX_GROUPS_PER_USER, // #108：防爆护栏，与创建上限一致（见 create）
    });
    return groups.map((g) => this.toDto(g));
  }

  async create(
    ownerID: string,
    dto: CreateConversationGroupDto,
  ): Promise<ConversationGroupDto> {
    const name = dto.name.trim();
    // round 2 review：创建上限与 list 的 take:200 护栏对齐 —— 否则第 201 个
    // 分组建得出来却永远列不出来（无法改名/删除/编辑成员）。会话分组正常是
    // 个位数量级，200 只会被失控客户端打到。
    const existing = await this.prisma.conversationGroup.count({
      where: { ownerID },
    });
    if (existing >= MAX_GROUPS_PER_USER) {
      throw new BadRequestException(
        `会话分组数量已达上限（${MAX_GROUPS_PER_USER}）`,
      );
    }
    try {
      const created = await this.prisma.conversationGroup.create({
        data: {
          ownerID,
          name,
          sortOrder: dto.sortOrder ?? 0,
          pinnedToTabs: dto.pinnedToTabs ?? true,
        },
        include: { memberships: true },
      });
      return this.toDto(created);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // unique([ownerID, name]) 冲突
        throw new ConflictException({
          message: '同名分组已存在',
          errorCode: ConversationGroupErrorCode.NameTaken,
        });
      }
      throw err;
    }
  }

  async update(
    ownerID: string,
    id: string,
    dto: UpdateConversationGroupDto,
  ): Promise<ConversationGroupDto> {
    // 先确认拥有权 —— 不让别的用户改我的组
    await this.ensureOwnership(ownerID, id);

    const data: Prisma.ConversationGroupUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.pinnedToTabs !== undefined) data.pinnedToTabs = dto.pinnedToTabs;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    try {
      const updated = await this.prisma.conversationGroup.update({
        where: { id },
        data,
        include: { memberships: true },
      });
      return this.toDto(updated);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          message: '同名分组已存在',
          errorCode: ConversationGroupErrorCode.NameTaken,
        });
      }
      throw err;
    }
  }

  async remove(ownerID: string, id: string): Promise<void> {
    await this.ensureOwnership(ownerID, id);
    // Cascade 自动清 memberships
    await this.prisma.conversationGroup.delete({ where: { id } });
  }

  async setMembers(
    ownerID: string,
    id: string,
    dto: SetConversationGroupMembersDto,
  ): Promise<ConversationGroupDto> {
    // Dedupe + 过滤空串（客户端再保险一次）
    const target = Array.from(
      new Set(
        dto.conversationIDs.map((c) => c.trim()).filter((c) => c.length > 0),
      ),
    );

    // 一个事务：在事务内重新校验拥有权（防 TOCTOU / 并发 remove），
    // 再清空旧成员、写入新成员；保证最终 membership === target。
    const result = await this.prisma.$transaction(async (tx) => {
      await this.ensureOwnership(ownerID, id, tx);
      await tx.conversationGroupMembership.deleteMany({
        where: { groupID: id },
      });
      if (target.length > 0) {
        await tx.conversationGroupMembership.createMany({
          data: target.map((conversationID) => ({
            groupID: id,
            conversationID,
          })),
          skipDuplicates: true,
        });
      }
      return tx.conversationGroup.findUniqueOrThrow({
        where: { id },
        include: { memberships: true },
      });
    });

    return this.toDto(result);
  }

  private async ensureOwnership(
    ownerID: string,
    id: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const group = await client.conversationGroup.findUnique({
      where: { id },
      select: { ownerID: true },
    });
    if (!group) {
      throw new NotFoundException({
        message: '分组不存在',
        errorCode: ConversationGroupErrorCode.NotFound,
      });
    }
    if (group.ownerID !== ownerID) {
      // 安全考虑：返 404 而不是 403，避免泄露"这个 id 存在但不属于你"
      throw new NotFoundException({
        message: '分组不存在',
        errorCode: ConversationGroupErrorCode.NotFound,
      });
    }
  }
}
