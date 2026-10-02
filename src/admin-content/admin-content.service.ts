import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { ListAdminPostsDto, ListAdminWordsDto } from './admin-content.dto';

const postSelect = {
  id: true,
  content: true,
  images: true,
  tags: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, nickname: true, accountId: true } },
  circle: { select: { id: true, name: true } },
} satisfies Prisma.CirclePostSelect;

@Injectable()
export class AdminContentService {
  constructor(private readonly prisma: PrismaService) {}

  async words(query: ListAdminWordsDto) {
    const where: Prisma.SensitiveWordWhereInput = query.search
      ? { word: { contains: query.search, mode: 'insensitive' } }
      : {};
    const [words, total] = await Promise.all([
      this.prisma.sensitiveWord.findMany({
        where,
        select: { id: true, word: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.sensitiveWord.count({ where }),
    ]);
    return { words, total, page: query.page, limit: query.limit };
  }

  async list(query: ListAdminPostsDto) {
    const where: Prisma.CirclePostWhereInput = {
      status: query.status,
      ...(query.search
        ? { content: { contains: query.search, mode: 'insensitive' as const } }
        : {}),
    };
    const [posts, total] = await Promise.all([
      this.prisma.circlePost.findMany({
        where,
        select: postSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.circlePost.count({ where }),
    ]);
    const counts = posts.length
      ? await this.prisma.circlePostReport.groupBy({
          by: ['postID'],
          where: { postID: { in: posts.map((post) => post.id) } },
          _count: { _all: true },
        })
      : [];
    const countMap = new Map(
      counts.map((row) => [row.postID, row._count._all]),
    );
    return {
      items: posts.map((post) => ({
        ...post,
        reportCount: countMap.get(post.id) ?? 0,
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async detail(id: string) {
    const post = await this.prisma.circlePost.findUnique({
      where: { id },
      select: postSelect,
    });
    if (!post) throw new NotFoundException('Post not found');
    const reportCount = await this.prisma.circlePostReport.count({
      where: { postID: id },
    });
    return { ...post, reportCount };
  }
}
