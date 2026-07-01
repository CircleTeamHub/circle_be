import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CreditPolicyAction } from '../credit-policy.service';

export class CreditPolicyCheckDto {
  @ApiProperty({ enum: CreditPolicyAction })
  @IsIn(Object.values(CreditPolicyAction))
  action!: CreditPolicyAction;

  @ApiPropertyOptional({ enum: ['SINGLE', 'GROUP'] })
  @IsOptional()
  @IsIn(['SINGLE', 'GROUP'])
  targetType?: 'SINGLE' | 'GROUP';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  targetId?: string;
}

export class CreditPolicyDecisionDto {
  @ApiProperty()
  allowed!: boolean;

  @ApiProperty({ nullable: true, enum: ['LOW_CREDIT_SCORE'] })
  code!: 'LOW_CREDIT_SCORE' | null;

  @ApiProperty()
  currentScore!: number;

  @ApiProperty()
  minScore!: number;

  @ApiProperty({ nullable: true })
  message!: string | null;
}
