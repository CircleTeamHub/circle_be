import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_ID_RULE_MESSAGE,
} from 'src/utils/account-id';

export class ChangeAccountIdDto {
  @ApiProperty({ example: 'alice_2024' })
  @IsString()
  @Matches(ACCOUNT_ID_PATTERN, { message: ACCOUNT_ID_RULE_MESSAGE })
  accountId: string;
}
