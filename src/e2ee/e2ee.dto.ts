import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class RegisterEncryptionDeviceDto {
  @ApiProperty({ type: String })
  @IsUUID()
  deviceId: string;
  @ApiProperty({ type: String })
  @Matches(/^[A-Za-z0-9+/]{43}=$/)
  publicKey: string;
  @ApiProperty({ type: String })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  label: string;
  @ApiProperty({ type: String })
  @Matches(/^[A-Za-z0-9+/]{86}==$/)
  signature: string;
}
export class EncryptionDeviceActionDto {
  @ApiProperty({ type: String })
  @IsUUID()
  actorDeviceId: string;
  @ApiProperty({ type: String })
  @Matches(/^[A-Za-z0-9+/]{86}==$/)
  signature: string;
}
export class PublishEncryptionPackageDto extends EncryptionDeviceActionDto {
  @ApiProperty({ type: String })
  @IsString()
  @MinLength(1)
  @MaxLength(24000)
  encoded: string;
}
export class EncryptionWelcomeDto {
  @ApiProperty({ type: String })
  @IsString()
  @MinLength(1)
  @MaxLength(500000)
  encoded: string;
  @ApiProperty({ type: String })
  @Matches(/^[A-Za-z0-9+/]{86}==$/)
  signature: string;
}
export class EncryptionEpochDto extends EncryptionDeviceActionDto {
  @ApiProperty({ type: String })
  @IsUUID()
  operationId: string;
  @ApiProperty({ type: Number })
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedEpoch: number;
  @IsArray()
  @ArrayMaxSize(64)
  @ArrayUnique()
  @Matches(/^[a-f0-9]{64}$/, { each: true })
  @ApiProperty({ type: [String] })
  packageIds: string[];
  @IsArray()
  @ArrayMaxSize(64)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  @ApiProperty({ type: [String] })
  removeDeviceIds: string[];
  @ApiProperty({ type: String })
  @IsString()
  @MinLength(1)
  @MaxLength(500000)
  commit: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => EncryptionWelcomeDto)
  @ApiPropertyOptional({ type: EncryptionWelcomeDto })
  welcome?: EncryptionWelcomeDto;
}
export class EncryptionEventsDto extends EncryptionDeviceActionDto {
  @ApiProperty({ type: Number })
  @IsInt()
  @Min(0)
  @Max(2147483646)
  afterEpoch: number;
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason?: string;
}

export class EncryptionRecoverySetupDto extends EncryptionDeviceActionDto {
  @ApiProperty() @IsUUID() recoveryId: string;
  @ApiProperty() @Matches(/^[A-Za-z0-9+/]{43}=$/) publicKey: string;
  @ApiProperty() @Matches(/^[A-Za-z0-9+/]{86}==$/) recoverySignature: string;
}
export class EncryptionRecoverDto extends EncryptionDeviceActionDto {
  @ApiProperty() @IsUUID() recoveryId: string;
  @ApiProperty() @Matches(/^[A-Za-z0-9+/]{86}==$/) recoverySignature: string;
}
export class EncryptionMessageRefDto {
  @ApiProperty() @IsUUID() conversationId: string;
  @ApiProperty() @IsUUID() senderDeviceId: string;
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  clientMessageId: string;
}
export class EncryptionArchiveItemDto extends EncryptionMessageRefDto {
  @ApiProperty()
  @IsString()
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/)
  @MaxLength(48000)
  ciphertext: string;
}
export class EncryptionArchiveResolveDto extends EncryptionDeviceActionDto {
  @ApiProperty({ type: [EncryptionMessageRefDto] })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EncryptionMessageRefDto)
  refs: EncryptionMessageRefDto[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason?: string;
}
export class EncryptionArchiveWriteDto extends EncryptionDeviceActionDto {
  @ApiProperty() @Matches(/^[A-Za-z0-9+/]{86}==$/) recoverySignature: string;
  @ApiProperty() @IsUUID() recoveryId: string;
  @ApiProperty({ type: [EncryptionArchiveItemDto] })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EncryptionArchiveItemDto)
  items: EncryptionArchiveItemDto[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason?: string;
}
export class EncryptionArchiveReadDto extends EncryptionDeviceActionDto {
  @ApiProperty() @IsUUID() recoveryId: string;
  @ApiProperty() @IsString() @Matches(/^(?:[a-f0-9]{64})?$/) after: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason?: string;
}
