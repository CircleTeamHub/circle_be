import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 查询参数刻意兼容 Nominatim 的拼法（`lat`/`lon`/`format`/`q`/`limit`）——
 * App 的地图页把这套参数写死在内联脚本里，换数据源不该逼客户端改协议。
 * `format` 我们不消费，但必须声明：全局 ValidationPipe 开了 forbidNonWhitelisted，
 * 没声明的参数会被打成 400。
 */
export class ReverseGeocodeQueryDto {
  @ApiProperty({ description: 'WGS-84 纬度', example: 22.545 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ description: 'WGS-84 经度', example: 114.0575 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  lon!: number;

  @ApiPropertyOptional({ description: '兼容 Nominatim，取值被忽略' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  format?: string;
}

export class SearchPlaceQueryDto {
  @ApiProperty({ description: '搜索关键词', example: '市民中心' })
  @IsString()
  @MaxLength(120)
  q!: string;

  @ApiPropertyOptional({ description: '返回条数上限', default: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number;

  @ApiPropertyOptional({ description: '兼容 Nominatim，取值被忽略' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  format?: string;
}

export class GeocodedPlaceDto {
  @ApiProperty({ description: '地点名，用作位置消息的标题' })
  name!: string;

  @ApiProperty({ description: '结构化全址' })
  display_name!: string;

  @ApiProperty({ description: 'WGS-84 纬度（字符串，与 Nominatim 一致）' })
  lat!: string;

  @ApiProperty({ description: 'WGS-84 经度（字符串，与 Nominatim 一致）' })
  lon!: string;
}
