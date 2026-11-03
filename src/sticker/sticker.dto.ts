import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateStickerDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  objectKey?: string;

  @IsOptional()
  @IsUUID()
  messageId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(16384)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(16384)
  height?: number;
}
