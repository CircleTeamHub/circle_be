import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { FriendReportStatus } from 'src/generated/prisma';

export const FRIEND_REPORT_REVIEW_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type FriendReportReviewDecision =
  (typeof FRIEND_REPORT_REVIEW_DECISIONS)[number];

export class ListFriendReportsQueryDto {
  @ApiPropertyOptional({
    enum: FriendReportStatus,
    default: FriendReportStatus.PENDING,
    description: 'Filter by review status (defaults to PENDING).',
  })
  @IsOptional()
  @IsEnum(FriendReportStatus)
  status?: FriendReportStatus;
}

export class ReviewFriendReportDto {
  @ApiProperty({ enum: FRIEND_REPORT_REVIEW_DECISIONS })
  @IsIn(FRIEND_REPORT_REVIEW_DECISIONS)
  decision: FriendReportReviewDecision;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Optional internal note explaining the decision.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class FriendReportUserDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ nullable: true })
  nickname: string | null;

  @ApiProperty({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty()
  accountId: string;
}

export class FriendReportAdminItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  category: string;

  @ApiProperty()
  description: string;

  @ApiProperty({ type: [String] })
  evidence: string[];

  @ApiProperty({ enum: FriendReportStatus })
  status: FriendReportStatus;

  @ApiProperty()
  createdAt: string;

  @ApiProperty({ nullable: true })
  reviewedAt: string | null;

  @ApiProperty({ nullable: true })
  reviewNote: string | null;

  @ApiProperty({ type: FriendReportUserDto })
  reporter: FriendReportUserDto;

  @ApiProperty({ type: FriendReportUserDto })
  target: FriendReportUserDto;

  @ApiProperty({ type: FriendReportUserDto, nullable: true })
  reviewedBy: FriendReportUserDto | null;
}
