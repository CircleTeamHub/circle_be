import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { QrService } from './qr.service';

describe('QrService', () => {
  const prisma = {
    qrToken: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    chatConversation: { findUnique: jest.fn() },
    chatMember: { count: jest.fn(), findFirst: jest.fn() },
    circle: { findUnique: jest.fn() },
    circleMember: { findUnique: jest.fn() },
    friend: { findFirst: jest.fn() },
  };
  const chatService = { joinStandaloneGroupViaQr: jest.fn() };
  const circleInvitation = { invite: jest.fn() };

  let service: QrService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new QrService(
      prisma as any,
      chatService as any,
      circleInvitation as any,
    );
  });

  describe('issueToken', () => {
    it('issues a non-expiring USER token for self', async () => {
      prisma.qrToken.findFirst.mockResolvedValue(null);
      prisma.qrToken.create.mockResolvedValue({});

      const dto = await service.issueToken('u1', 'USER');

      expect(dto.expiresAt).toBeNull();
      expect(dto.token).toHaveLength(32);
      expect(prisma.qrToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'USER',
          targetID: 'u1',
          issuerID: 'u1',
          expiresAt: null,
        }),
      });
    });

    it('rejects issuing a USER token for someone else', async () => {
      await expect(service.issueToken('u1', 'USER', 'u2')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.qrToken.create).not.toHaveBeenCalled();
    });

    it('reuses an unexpired token inside the rotation window', async () => {
      prisma.qrToken.findFirst.mockResolvedValue({
        token: 'reused-token',
        expiresAt: new Date(Date.now() + 6 * 24 * 3600 * 1000),
      });
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: 'GROUP',
        circleID: null,
      });
      prisma.chatMember.findFirst.mockResolvedValue({ id: 'seat' });

      const dto = await service.issueToken('u1', 'GROUP', 'conv-1');

      expect(dto.token).toBe('reused-token');
      expect(prisma.qrToken.create).not.toHaveBeenCalled();
    });

    it('issues a 7-day GROUP token for a seated member', async () => {
      prisma.qrToken.findFirst.mockResolvedValue(null);
      prisma.qrToken.create.mockResolvedValue({});
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: 'GROUP',
        circleID: null,
      });
      prisma.chatMember.findFirst.mockResolvedValue({ id: 'seat' });

      const dto = await service.issueToken('u1', 'GROUP', 'conv-1');

      expect(dto.expiresAt).not.toBeNull();
      const remaining =
        new Date(dto.expiresAt as string).getTime() - Date.now();
      expect(remaining).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
      expect(remaining).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);
    });

    it('rejects GROUP tokens for circle-managed conversations', async () => {
      prisma.qrToken.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: 'GROUP',
        circleID: 'circle-1',
      });

      await expect(service.issueToken('u1', 'GROUP', 'conv-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects GROUP tokens for non-seated users', async () => {
      prisma.qrToken.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: 'GROUP',
        circleID: null,
      });
      prisma.chatMember.findFirst.mockResolvedValue(null);

      await expect(service.issueToken('u1', 'GROUP', 'conv-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lets a plain member issue a CIRCLE token only when memberCanInvite is on', async () => {
      prisma.qrToken.findFirst.mockResolvedValue(null);
      prisma.qrToken.create.mockResolvedValue({});
      prisma.circle.findUnique.mockResolvedValue({
        deleted: false,
        adminState: 'ACTIVE',
        memberCanInvite: false,
      });
      prisma.circleMember.findUnique.mockResolvedValue({
        role: 'MEMBER',
        status: 'ACTIVE',
      });

      await expect(
        service.issueToken('u1', 'CIRCLE', 'circle-1'),
      ).rejects.toThrow(ForbiddenException);

      prisma.circle.findUnique.mockResolvedValue({
        deleted: false,
        adminState: 'ACTIVE',
        memberCanInvite: true,
      });
      await expect(
        service.issueToken('u1', 'CIRCLE', 'circle-1'),
      ).resolves.toMatchObject({ type: 'CIRCLE' });
    });

    it('rejects CIRCLE tokens for disabled circles', async () => {
      prisma.qrToken.findFirst.mockResolvedValue(null);
      prisma.circle.findUnique.mockResolvedValue({
        deleted: false,
        adminState: 'DISMISSED',
        memberCanInvite: true,
      });

      await expect(
        service.issueToken('u1', 'CIRCLE', 'circle-1'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('resolveToken', () => {
    it('404s on unknown or revoked tokens', async () => {
      prisma.qrToken.findUnique.mockResolvedValue(null);
      await expect(service.resolveToken('u1', 'nope')).rejects.toThrow(
        NotFoundException,
      );

      prisma.qrToken.findUnique.mockResolvedValue({
        revokedAt: new Date(),
      });
      await expect(service.resolveToken('u1', 'revoked')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('410s on expired tokens', async () => {
      prisma.qrToken.findUnique.mockResolvedValue({
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.resolveToken('u1', 'old')).rejects.toThrow(
        GoneException,
      );
    });

    it('resolves a USER token with friendship state', async () => {
      prisma.qrToken.findUnique.mockResolvedValue({
        type: 'USER',
        targetID: 'u2',
        issuerID: 'u2',
        revokedAt: null,
        expiresAt: null,
      });
      prisma.user.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.id === 'u2'
            ? { nickname: '丁哥', avatarUrl: 'a.png', status: 'ACTIVE' }
            : null,
        ),
      );
      prisma.friend.findFirst.mockResolvedValue({ id: 'f1' });

      const dto = await service.resolveToken('u1', 'tok');

      expect(dto).toMatchObject({
        type: 'USER',
        targetId: 'u2',
        name: '丁哥',
        viewerState: 'FRIEND',
        memberCount: null,
      });
    });

    it('marks ALREADY_IN for seated group members and rejects dead groups', async () => {
      prisma.qrToken.findUnique.mockResolvedValue({
        type: 'GROUP',
        targetID: 'conv-1',
        issuerID: 'u2',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 1000_000),
      });
      prisma.user.findUnique.mockResolvedValue({ nickname: 'issuer' });
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: 'GROUP',
        circleID: null,
        name: '臭鸡群',
      });
      prisma.chatMember.count.mockResolvedValue(3);
      prisma.chatMember.findFirst.mockResolvedValue({ id: 'seat' });

      await expect(service.resolveToken('u1', 'tok')).resolves.toMatchObject({
        type: 'GROUP',
        name: '臭鸡群',
        memberCount: 3,
        viewerState: 'ALREADY_IN',
      });

      prisma.chatMember.count.mockResolvedValue(0);
      prisma.chatMember.findFirst.mockResolvedValue(null);
      await expect(service.resolveToken('u1', 'tok')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects circle tokens once the circle is disabled', async () => {
      prisma.qrToken.findUnique.mockResolvedValue({
        type: 'CIRCLE',
        targetID: 'circle-1',
        issuerID: 'u2',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 1000_000),
      });
      prisma.user.findUnique.mockResolvedValue({ nickname: 'issuer' });
      prisma.circle.findUnique.mockResolvedValue({
        name: '圈',
        avatarUrl: null,
        memberCount: 5,
        deleted: false,
        adminState: 'DISABLED',
      });

      await expect(service.resolveToken('u1', 'tok')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('joinByToken', () => {
    it('rejects join on USER tokens', async () => {
      prisma.qrToken.findUnique.mockResolvedValue({
        type: 'USER',
        targetID: 'u2',
        issuerID: 'u2',
        revokedAt: null,
        expiresAt: null,
      });

      await expect(service.joinByToken('u1', 'tok')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('seats the scanner into a standalone group', async () => {
      prisma.qrToken.findUnique.mockResolvedValue({
        type: 'GROUP',
        targetID: 'conv-1',
        issuerID: 'u2',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 1000_000),
      });
      chatService.joinStandaloneGroupViaQr.mockResolvedValue({ id: 'conv-1' });

      await expect(service.joinByToken('u1', 'tok')).resolves.toEqual({
        type: 'GROUP',
        conversationId: 'conv-1',
        status: 'JOINED',
      });
      expect(chatService.joinStandaloneGroupViaQr).toHaveBeenCalledWith(
        'u1',
        'conv-1',
      );
    });

    it('joins a circle through the invitation flow with issuer as inviter', async () => {
      prisma.qrToken.findUnique.mockResolvedValue({
        type: 'CIRCLE',
        targetID: 'circle-1',
        issuerID: 'issuer-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 1000_000),
      });
      circleInvitation.invite.mockResolvedValue({ status: 'APPROVED' });

      await expect(service.joinByToken('u1', 'tok')).resolves.toEqual({
        type: 'CIRCLE',
        circleId: 'circle-1',
        status: 'JOINED',
      });
      expect(circleInvitation.invite).toHaveBeenCalledWith(
        'issuer-1',
        'u1',
        'circle-1',
        { applicantConsented: true },
      );

      // 严格模式:建了担保单,等验证人 —— PENDING 透传给前端换文案。
      circleInvitation.invite.mockResolvedValue({ status: 'PENDING' });
      await expect(service.joinByToken('u1', 'tok')).resolves.toMatchObject({
        status: 'PENDING',
      });
    });
  });
});
