import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'jimmyddddd' })
  @IsString()
  @IsNotEmpty()
  @Length(4, 32)
  accountId: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 64)
  password: string;

  /**
   * OpenIM platform ID — 1=iOS, 2=Android, 5=Web. The imToken returned by
   * OpenIM is bound to one platform; the client must declare which platform
   * it will log in from so we mint a token that platform can use.
   */
  @ApiProperty({ example: 1, required: false })
  @IsOptional()
  @IsIn([1, 2, 5])
  platform?: 1 | 2 | 5;
}
