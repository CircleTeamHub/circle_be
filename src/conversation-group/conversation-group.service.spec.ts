import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { ConversationGroupService } from './conversation-group.service';

describe('ConversationGroupService', () => {
  let service: ConversationGroupService;

  const prisma = {
    conversationGroup: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    conversationGroupMembership: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    $transaction: jest.fn((cb: any) => cb(prisma as any)),
  };

  const OWNER_ID = 'owner-1';
  const OTHER_OWNER_ID = 'owner-2';

  const buildGroupRow = (overrides: Partial<any> = {}) => ({
    id: 'group-1',
    ownerID: OWNER_ID,
    name: '家人',
    sortOrder: 0,
    pinnedToTabs: true,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    memberships: [
      { groupID: 'group-1', conversationID: 'c-2', createdAt: new Date() },
      { groupID: 'group-1', conversationID: 'c-1', createdAt: new Date() },
    ],
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationGroupService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(ConversationGroupService);
  });

  describe('list', () => {
    it('returns groups for owner with sorted conversationIDs and ISO timestamps', async () => {
      prisma.conversationGroup.findMany.mockResolvedValue([buildGroupRow()]);

      const result = await service.list(OWNER_ID);

      expect(prisma.conversationGroup.findMany).toHaveBeenCalledWith({
        where: { ownerID: OWNER_ID },
        include: { memberships: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take: 200,
      });
      expect(result).toEqual([
        {
          id: 'group-1',
          name: '家人',
          sortOrder: 0,
          pinnedToTabs: true,
          conversationIDs: ['c-1', 'c-2'], // sorted alphabetically
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ]);
    });
  });

  describe('create', () => {
    it('trims name and applies defaults for pinnedToTabs and sortOrder', async () => {
      prisma.conversationGroup.create.mockResolvedValue(
        buildGroupRow({ memberships: [] }),
      );

      await service.create(OWNER_ID, { name: '  家人  ' });

      expect(prisma.conversationGroup.create).toHaveBeenCalledWith({
        data: {
          ownerID: OWNER_ID,
          name: '家人',
          sortOrder: 0,
          pinnedToTabs: true,
        },
        include: { memberships: true },
      });
    });

    it('translates P2002 (unique constraint) into ConflictException', async () => {
      prisma.conversationGroup.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.create(OWNER_ID, { name: '家人' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('honors explicit pinnedToTabs=false and sortOrder', async () => {
      prisma.conversationGroup.create.mockResolvedValue(
        buildGroupRow({ pinnedToTabs: false, sortOrder: 5, memberships: [] }),
      );

      await service.create(OWNER_ID, {
        name: '工作',
        pinnedToTabs: false,
        sortOrder: 5,
      });

      expect(prisma.conversationGroup.create).toHaveBeenCalledWith({
        data: {
          ownerID: OWNER_ID,
          name: '工作',
          sortOrder: 5,
          pinnedToTabs: false,
        },
        include: { memberships: true },
      });
    });
  });

  describe('update', () => {
    it('throws NotFoundException if group is not owned by caller (no 403 leak)', async () => {
      prisma.conversationGroup.findUnique.mockResolvedValue({
        ownerID: OTHER_OWNER_ID,
      });

      await expect(
        service.update(OWNER_ID, 'group-1', { name: '改名' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.conversationGroup.update).not.toHaveBeenCalled();
    });

    it('only writes fields that were provided', async () => {
      prisma.conversationGroup.findUnique.mockResolvedValue({
        ownerID: OWNER_ID,
      });
      prisma.conversationGroup.update.mockResolvedValue(
        buildGroupRow({ pinnedToTabs: false }),
      );

      await service.update(OWNER_ID, 'group-1', { pinnedToTabs: false });

      expect(prisma.conversationGroup.update).toHaveBeenCalledWith({
        where: { id: 'group-1' },
        data: { pinnedToTabs: false },
        include: { memberships: true },
      });
    });
  });

  describe('remove', () => {
    it('refuses to delete a group owned by someone else', async () => {
      prisma.conversationGroup.findUnique.mockResolvedValue({
        ownerID: OTHER_OWNER_ID,
      });

      await expect(service.remove(OWNER_ID, 'group-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.conversationGroup.delete).not.toHaveBeenCalled();
    });

    it('deletes when caller owns the group (memberships cascade via Prisma)', async () => {
      prisma.conversationGroup.findUnique.mockResolvedValue({
        ownerID: OWNER_ID,
      });
      prisma.conversationGroup.delete.mockResolvedValue(undefined);

      await service.remove(OWNER_ID, 'group-1');

      expect(prisma.conversationGroup.delete).toHaveBeenCalledWith({
        where: { id: 'group-1' },
      });
    });
  });

  describe('setMembers', () => {
    it('replaces membership atomically — clear then insert in one transaction', async () => {
      prisma.conversationGroup.findUnique.mockResolvedValue({
        ownerID: OWNER_ID,
      });
      prisma.conversationGroup.findUniqueOrThrow.mockResolvedValue(
        buildGroupRow({
          memberships: [
            {
              groupID: 'group-1',
              conversationID: 'c-a',
              createdAt: new Date(),
            },
            {
              groupID: 'group-1',
              conversationID: 'c-b',
              createdAt: new Date(),
            },
          ],
        }),
      );

      await service.setMembers(OWNER_ID, 'group-1', {
        conversationIDs: ['c-a', 'c-b'],
      });

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(
        prisma.conversationGroupMembership.deleteMany,
      ).toHaveBeenCalledWith({
        where: { groupID: 'group-1' },
      });
      expect(
        prisma.conversationGroupMembership.createMany,
      ).toHaveBeenCalledWith({
        data: [
          { groupID: 'group-1', conversationID: 'c-a' },
          { groupID: 'group-1', conversationID: 'c-b' },
        ],
        skipDuplicates: true,
      });
    });

    it('dedupes the input list before writing', async () => {
      prisma.conversationGroup.findUnique.mockResolvedValue({
        ownerID: OWNER_ID,
      });
      prisma.conversationGroup.findUniqueOrThrow.mockResolvedValue(
        buildGroupRow({ memberships: [] }),
      );

      await service.setMembers(OWNER_ID, 'group-1', {
        conversationIDs: ['c-1', 'c-1', 'c-2', '   ', '   c-3   '],
      });

      const createCall =
        prisma.conversationGroupMembership.createMany.mock.calls[0][0];
      expect(createCall.data).toEqual([
        { groupID: 'group-1', conversationID: 'c-1' },
        { groupID: 'group-1', conversationID: 'c-2' },
        { groupID: 'group-1', conversationID: 'c-3' },
      ]);
    });

    it('skips the createMany call when the target is empty (clear-all)', async () => {
      prisma.conversationGroup.findUnique.mockResolvedValue({
        ownerID: OWNER_ID,
      });
      prisma.conversationGroup.findUniqueOrThrow.mockResolvedValue(
        buildGroupRow({ memberships: [] }),
      );

      await service.setMembers(OWNER_ID, 'group-1', { conversationIDs: [] });

      expect(prisma.conversationGroupMembership.deleteMany).toHaveBeenCalled();
      expect(
        prisma.conversationGroupMembership.createMany,
      ).not.toHaveBeenCalled();
    });
  });
});
