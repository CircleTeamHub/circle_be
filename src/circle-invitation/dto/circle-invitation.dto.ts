import {
  IsBoolean,
  IsNotEmpty,
  IsUUID,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class InviteToCircleDto {
  @ApiProperty()
  @IsUUID()
  circleId: string;

  @ApiProperty()
  @IsUUID()
  applicantId: string;
}

export class AddVerifierDto {
  @ApiProperty()
  @IsUUID()
  verifierId: string;
}

export class RespondVerificationDto {
  @ApiProperty()
  @IsBoolean()
  @IsNotEmpty()
  approve: boolean;
}

// ── Response DTOs ────────────────────────────────────────────────────────────

export class InvitationUserDto {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  accountId: string;
}

export class InvitationVerifierDto {
  id: string;
  verifier: InvitationUserDto;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  respondedAt: string | null;
}

export class InvitationDto {
  id: string;
  circleId: string;
  circleName: string;
  applicant: InvitationUserDto;
  inviter: InvitationUserDto;
  requiredCount: number;
  approvedCount: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ADMIN_APPROVED';
  verifiers: InvitationVerifierDto[];
  createdAt: string;
}
