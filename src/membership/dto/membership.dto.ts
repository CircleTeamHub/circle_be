import { ApiProperty } from '@nestjs/swagger';

export class MembershipPlanDto {
  @ApiProperty() level: number;
  @ApiProperty() name: string;
  @ApiProperty() price: number;
  @ApiProperty() perks: string;
}
