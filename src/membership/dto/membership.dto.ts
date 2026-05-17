import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { WalletDto } from 'src/coin/dto/coin.dto';

export class MembershipPlanDto {
  @ApiProperty() level: number;
  @ApiProperty() name: string;
  @ApiProperty() price: number;
  @ApiProperty() perks: string;
}

export class UpgradeMembershipDto {
  @ApiProperty({ example: 3, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  level: number;
}

export class MembershipUserDto {
  @ApiProperty() id: string;
  @ApiProperty() vipLevel: number;
  @ApiProperty() creditScore: number;
}

export class UpgradeMembershipResponseDto {
  @ApiProperty({ type: MembershipUserDto })
  user: MembershipUserDto;

  @ApiProperty({ type: WalletDto })
  wallet: WalletDto;

  @ApiProperty({ type: MembershipPlanDto })
  plan: MembershipPlanDto;
}
