import { IsBoolean, IsOptional } from 'class-validator';

export class ClearHistoryDto {
  /** DIRECT 任一成员可用;GROUP 仅群主/管理员可用;TEMP/SUPPORT 仍仅个人。 */
  @IsOptional()
  @IsBoolean()
  forEveryone?: boolean;
}
