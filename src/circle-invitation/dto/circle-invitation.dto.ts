import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const DEFAULT_INVITATION_LIST_LIMIT = 50;
export const MAX_INVITATION_LIST_LIMIT = 100;

export class InvitationListQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Last invitation id returned by the previous page',
  })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({
    default: DEFAULT_INVITATION_LIST_LIMIT,
    minimum: 1,
    maximum: MAX_INVITATION_LIST_LIMIT,
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_INVITATION_LIST_LIMIT)
  limit: number = DEFAULT_INVITATION_LIST_LIMIT;
}

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
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ADMIN_APPROVED' | 'CANCELLED';
  verifiers: InvitationVerifierDto[];
  createdAt: string;
}
