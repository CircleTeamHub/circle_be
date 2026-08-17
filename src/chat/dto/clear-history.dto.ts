import { IsBoolean, IsOptional } from 'class-validator';

export class ClearHistoryDto {
  /** 仅 DIRECT 会话允许；GROUP/TEMP 即使传 true 也只清发起者。 */
  @IsOptional()
  @IsBoolean()
  forEveryone?: boolean;
}
