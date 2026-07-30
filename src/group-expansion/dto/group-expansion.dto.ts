import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  GROUP_EXPANSION_PRODUCTS,
  GroupExpansionProductId,
} from '../group-expansion.catalog';

const GROUP_EXPANSION_PRODUCT_IDS = GROUP_EXPANSION_PRODUCTS.map(
  ({ id }) => id,
);

export class PurchaseGroupExpansionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  circleId: string;

  @ApiProperty({ enum: GROUP_EXPANSION_PRODUCT_IDS })
  @IsIn(GROUP_EXPANSION_PRODUCT_IDS)
  productId: GroupExpansionProductId;

  @ApiProperty({ required: false, minimum: 1 })
  @ValidateIf(
    (dto: PurchaseGroupExpansionDto) =>
      dto.expectedPrice !== undefined || dto.expectedSeats !== undefined,
  )
  @IsDefined()
  @IsInt()
  @Min(1)
  expectedPrice?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 3000 })
  @ValidateIf(
    (dto: PurchaseGroupExpansionDto) =>
      dto.expectedPrice !== undefined || dto.expectedSeats !== undefined,
  )
  @IsDefined()
  @IsInt()
  @Min(1)
  @Max(3000)
  expectedSeats?: number;
}

export class GroupExpansionCircleQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  circleId: string;
}

export class ListGroupExpansionOrdersQueryDto extends GroupExpansionCircleQueryDto {
  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}

export class GroupExpansionProductDto {
  @ApiProperty({ enum: GROUP_EXPANSION_PRODUCT_IDS })
  id: GroupExpansionProductId;
  @ApiProperty() name: string;
  @ApiProperty() seats: number;
  @ApiProperty() price: number;
  @ApiProperty() purchasable: boolean;
  @ApiProperty({ nullable: true })
  unavailableReason: 'MAX_CAPACITY_EXCEEDED' | null;
  @ApiProperty() resultingMaxMembers: number;
}

export class GroupExpansionProductsResultDto {
  @ApiProperty() circleId: string;
  @ApiProperty() memberCount: number;
  @ApiProperty() currentMaxMembers: number;
  @ApiProperty() expansionSeats: number;
  @ApiProperty() hardLimit: number;
  @ApiProperty({ type: [GroupExpansionProductDto] })
  products: GroupExpansionProductDto[];
}

export class GroupExpansionPurchaseResultDto {
  @ApiProperty() orderId: string;
  @ApiProperty() circleId: string;
  @ApiProperty() productId: string;
  @ApiProperty() productName: string;
  @ApiProperty() seats: number;
  @ApiProperty() price: number;
  @ApiProperty() previousMaxMembers: number;
  @ApiProperty() newMaxMembers: number;
  @ApiProperty() walletBalanceAfter: number;
}

export class GroupExpansionOrderDto extends GroupExpansionPurchaseResultDto {
  @ApiProperty() createdAt: Date;
}

export class GroupExpansionOrdersResultDto {
  @ApiProperty({ type: [GroupExpansionOrderDto] })
  items: GroupExpansionOrderDto[];
  @ApiProperty({ nullable: true }) nextCursor: string | null;
}
