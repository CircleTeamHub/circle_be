import { Type, Transform } from 'class-transformer';
import {
  IsUUID,
  IsEnum,
  Matches,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_ID_RULE_MESSAGE,
} from 'src/utils/account-id';
import { AdminConsoleRole } from 'src/generated/prisma';

export class AdminPageQuery {
  @Type(() => Number) @IsInt() @Min(1) @Max(500) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;
}

export class UpdateAdminAccessDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 50)
  nickname?: string;
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @Matches(ACCOUNT_ID_PATTERN, { message: ACCOUNT_ID_RULE_MESSAGE })
  accountId?: string;
  @IsEnum(AdminConsoleRole) role: AdminConsoleRole;
  @IsInt() @Min(0) version: number;
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(2, 500)
  reason: string;
}

export class UpdateAdminNicknameDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 50)
  nickname: string;
}

export class CreateAdminAccountDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(1, 50)
  nickname: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Matches(ACCOUNT_ID_PATTERN, { message: ACCOUNT_ID_RULE_MESSAGE })
  accountId: string;

  @IsString()
  @Length(12, 64)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d)[\s\S]+$/)
  password: string;

  @IsEnum(AdminConsoleRole)
  role: AdminConsoleRole;
}

export class ResetAdminPasswordDto {
  @IsString()
  @Length(12, 64)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d)[\s\S]+$/)
  newPassword: string;

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(2, 500)
  reason: string;
}

export class DeleteAdminAccountDto {
  @IsInt() @Min(0) version: number;
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(2, 500)
  reason: string;
}

export class AdminAccountAvailabilityQuery {
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @Matches(ACCOUNT_ID_PATTERN, { message: ACCOUNT_ID_RULE_MESSAGE })
  accountId: string;

  @IsOptional()
  @IsUUID()
  excludeUserId?: string;
}
