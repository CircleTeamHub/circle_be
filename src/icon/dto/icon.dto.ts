import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum DisplayIconTypeDto {
  SYSTEM = 'SYSTEM',
  CIRCLE = 'CIRCLE',
}

export enum SystemIconKeyDto {
  VIP = 'VIP',
  NEW_USER = 'NEW_USER',
  PARTNER = 'PARTNER',
  TOP_COLLABORATOR = 'TOP_COLLABORATOR',
  VERIFIED_PROFILE = 'VERIFIED_PROFILE',
  CIRCLE_BUILDER = 'CIRCLE_BUILDER',
}

export class DisplayIconDto {
  @ApiProperty()
  @Expose()
  id: string;

  @ApiProperty({ enum: DisplayIconTypeDto })
  @Expose()
  type: DisplayIconTypeDto;

  @ApiProperty()
  @Expose()
  title: string;

  @ApiPropertyOptional()
  @Expose()
  imageUrl: string | null;

  @ApiPropertyOptional()
  @Expose()
  fallbackIconName: string | null;

  @ApiPropertyOptional()
  @Expose()
  circleId?: string;

  @ApiPropertyOptional()
  @Expose()
  circleName?: string;

  @ApiPropertyOptional({ enum: SystemIconKeyDto })
  @Expose()
  systemKey?: SystemIconKeyDto;

  @ApiPropertyOptional({ example: 100 })
  @Expose()
  recognitionCount?: number;

  @ApiProperty()
  @Expose()
  sortOrder: number;
}

export class IconOptionDto {
  @ApiProperty({ enum: DisplayIconTypeDto })
  type: DisplayIconTypeDto;

  @ApiProperty()
  title: string;

  @ApiPropertyOptional()
  imageUrl: string | null;

  @ApiPropertyOptional()
  fallbackIconName: string | null;

  @ApiProperty()
  selected: boolean;

  @ApiPropertyOptional()
  circleId?: string;

  @ApiPropertyOptional()
  circleName?: string;

  @ApiPropertyOptional({ enum: SystemIconKeyDto })
  systemKey?: SystemIconKeyDto;

  @ApiPropertyOptional({ example: 100 })
  recognitionCount?: number;
}

export class IconOptionsResponseDto {
  @ApiProperty({ type: [IconOptionDto] })
  systemIcons: IconOptionDto[];

  @ApiProperty({ type: [IconOptionDto] })
  circleIcons: IconOptionDto[];

  @ApiProperty({ type: [DisplayIconDto] })
  displayIcons: DisplayIconDto[];
}

export class UpdateDisplayIconItemDto {
  @ApiProperty({ enum: DisplayIconTypeDto })
  @IsEnum(DisplayIconTypeDto)
  displayType: DisplayIconTypeDto;

  @ApiPropertyOptional({ enum: SystemIconKeyDto })
  @ValidateIf(
    (value: UpdateDisplayIconItemDto) =>
      value.displayType === DisplayIconTypeDto.SYSTEM,
  )
  @IsEnum(SystemIconKeyDto)
  systemKey?: SystemIconKeyDto;

  @ApiPropertyOptional()
  @ValidateIf(
    (value: UpdateDisplayIconItemDto) =>
      value.displayType === DisplayIconTypeDto.CIRCLE,
  )
  @IsUUID()
  circleId?: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4)
  sortOrder: number;
}

export class UpdateDisplayIconsDto {
  @ApiProperty({ type: [UpdateDisplayIconItemDto] })
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique((item: UpdateDisplayIconItemDto) =>
    item.displayType === DisplayIconTypeDto.SYSTEM
      ? `system:${item.systemKey}`
      : `circle:${item.circleId}`,
  )
  @ValidateNested({ each: true })
  @Type(() => UpdateDisplayIconItemDto)
  items: UpdateDisplayIconItemDto[];
}

export class UploadCircleIconDto {
  @ApiProperty()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  imageUrl: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;
}

export class SelectCircleIconDto {
  @ApiProperty()
  @IsUUID()
  iconAssetId: string;
}
