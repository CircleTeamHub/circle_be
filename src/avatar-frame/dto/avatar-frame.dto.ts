import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, IsUUID, ValidateIf } from 'class-validator';

export class UpdateEquippedAvatarFrameDto {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'Avatar frame to equip, or null to clear the selection.',
  })
  @IsDefined()
  @ValidateIf((dto: UpdateEquippedAvatarFrameDto) => dto.frameId !== null)
  @IsUUID()
  frameId: string | null;
}

export class AvatarFrameOwnedSourceDto {
  @ApiProperty({ enum: ['MEMBERSHIP', 'ADMIN'] })
  type: 'MEMBERSHIP' | 'ADMIN';

  @ApiPropertyOptional()
  minimumVipLevel?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  grantId?: string;

  @ApiProperty({ nullable: true })
  expiresAt: Date | null;
}

export class AvatarFrameInventoryItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  key: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  description: string;

  @ApiProperty({ nullable: true })
  imageUrl: string | null;

  @ApiProperty({ nullable: true })
  minimumVipLevel: number | null;

  @ApiProperty({ type: [AvatarFrameOwnedSourceDto] })
  ownedSources: AvatarFrameOwnedSourceDto[];

  @ApiProperty({ nullable: true })
  availableUntil: Date | null;

  @ApiProperty()
  equipped: boolean;
}

export class AvatarFrameInventoryDto {
  @ApiProperty({ format: 'uuid', nullable: true })
  equippedFrameId: string | null;

  @ApiProperty({ type: [AvatarFrameInventoryItemDto] })
  items: AvatarFrameInventoryItemDto[];
}
