import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { RawResponse } from 'src/decorators/raw-response.decorator';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  GeocodedPlaceDto,
  ReverseGeocodeQueryDto,
  SearchPlaceQueryDto,
} from './geo.dto';
import { GeoService } from './geo.service';

/**
 * 地名服务的服务端出口。
 *
 * 为什么必须经过这里，而不是让 App 直连高德：高德的 Web 服务密钥没有域名限制，
 * 一旦下发到客户端就等于公开，谁都能拿去刷爆日配额。密钥留在服务端，客户端只看得到
 * 地名。顺带也把 GCJ-02 ↔ WGS-84 的转换收在这一层，客户端的坐标口径始终是 WGS-84。
 *
 * 响应用 @RawResponse 绕开全局信封：这套 `name`/`display_name`/`lat`/`lon` 的形状
 * 是 App 地图页早就在消费的 Nominatim 协议，包上信封客户端就读不到了。
 */
@ApiTags('Geo')
@ApiBearerAuth()
@UseGuards(JwtGuard, ThrottlerGuard)
@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  /**
   * 查不到时返回空对象而不是 404 —— 地名是锦上添花，客户端拿不到就继续显示经纬度，
   * 不该走错误分支弹提示。
   */
  @Get('reverse')
  @RawResponse()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOkResponse({ type: GeocodedPlaceDto })
  async reverse(
    @Query() query: ReverseGeocodeQueryDto,
  ): Promise<GeocodedPlaceDto | Record<string, never>> {
    const place = await this.geo.reverse(query.lat, query.lon);
    return place ?? {};
  }

  @Get('search')
  @RawResponse()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOkResponse({ type: [GeocodedPlaceDto] })
  search(@Query() query: SearchPlaceQueryDto): Promise<GeocodedPlaceDto[]> {
    return this.geo.search(query.q, query.limit ?? 10);
  }
}
