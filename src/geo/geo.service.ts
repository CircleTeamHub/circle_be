import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { gcj02ToWgs84, isOutOfChina, wgs84ToGcj02 } from './coordinates';
import { sanitizeLogValue } from '../logging/log-sanitizer';
import { attemptDiagnostic } from '../logging/http-failure.logger';

/**
 * 一条地名结果。字段名刻意与 Nominatim 对齐 —— App 侧的地图页早就在消费这个
 * 形状（`name` 做标题、`display_name` 做全称、`lat`/`lon` 是字符串），换成高德
 * 只是把数据来源换掉，客户端一行都不用改。
 */
export type GeocodedPlace = {
  name: string;
  display_name: string;
  lat: string;
  lon: string;
};

const AMAP_REGEO_URL = 'https://restapi.amap.com/v3/geocode/regeo';
const AMAP_PLACE_TEXT_URL = 'https://restapi.amap.com/v5/place/text';

const REQUEST_TIMEOUT_MS = 6_000;
/** 高德 place/text 的硬上限；传超了它自己会报错。 */
const MAX_PAGE_SIZE = 25;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 5_000;
/** 高德要求经纬度小数点后不超过 6 位。 */
const AMAP_COORDINATE_PRECISION = 6;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

/**
 * 有界 TTL 缓存。
 *
 * 高德的免费配额按天算，而聊天列表里同一条位置消息会被反复展开 —— 不缓存的话
 * 一个用户来回滑几屏就能把配额烧掉。地名对同一个坐标是稳定的，缓存一天足够。
 * 条目数封顶是为了防止长跑进程被无限增长的 Map 拖垮。
 */
class BoundedCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // 读一次挪到队尾，让淘汰按最近使用顺序发生。
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  source: Record<string, unknown> | null,
  key: string,
): string {
  const value = source?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** 高德的 location 是 `"经度,纬度"` 字符串，且是 GCJ-02。 */
function parseAmapLocation(
  raw: string,
): { latitude: number; longitude: number } | null {
  const [longitude, latitude] = raw.split(',').map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);
  private readonly reverseCache = new BoundedCache<GeocodedPlace | null>();
  private readonly searchCache = new BoundedCache<GeocodedPlace[]>();
  /** 同一个 key 的并发请求合流成一个，防止一屏位置消息同时打爆高德。 */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly config: ConfigService) {}

  private get amapKey(): string {
    return (
      this.config.get<string>('AMAP_WEB_SERVICE_KEY') ??
      process.env.AMAP_WEB_SERVICE_KEY ??
      ''
    ).trim();
  }

  /**
   * 坐标 → 地名。入参与出参都是 WGS-84，GCJ-02 只存在于打给高德的那一瞬间。
   *
   * 查不到一律返回 null（客户端会退回显示经纬度），绝不抛错 —— 地名只是锦上添花，
   * 不该让一条位置消息渲染失败。
   */
  async reverse(
    latitude: number,
    longitude: number,
  ): Promise<GeocodedPlace | null> {
    const key = this.amapKey;
    // 境外没有高德数据（实测境外瓦片是空白图），省掉这一次往返和配额。
    if (!key || isOutOfChina(latitude, longitude)) return null;

    const gcj02 = wgs84ToGcj02(latitude, longitude);
    if (!gcj02) return null;

    const cacheKey = `reverse:${latitude.toFixed(5)},${longitude.toFixed(5)}`;
    const cached = this.reverseCache.get(cacheKey);
    if (cached !== undefined) return cached;

    return this.dedupe(cacheKey, async () => {
      const payload = await this.requestAmap(AMAP_REGEO_URL, {
        key,
        location: `${gcj02.longitude.toFixed(AMAP_COORDINATE_PRECISION)},${gcj02.latitude.toFixed(AMAP_COORDINATE_PRECISION)}`,
        radius: '1000',
        extensions: 'all',
      });
      const place = payload
        ? this.readReverseResult(payload, latitude, longitude)
        : null;
      // 失败不写缓存，否则一次抖动就把这个点钉死在经纬度上一整天。
      if (payload) this.reverseCache.set(cacheKey, place);
      return place;
    });
  }

  /**
   * 关键词 → 候选地点列表。返回的坐标已经减偏回 WGS-84，可以直接入库。
   */
  async search(query: string, limit: number): Promise<GeocodedPlace[]> {
    const key = this.amapKey;
    const keywords = query.trim();
    if (!key || !keywords) return [];

    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(limit) || 1),
    );
    const cacheKey = `search:${pageSize}:${keywords}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached !== undefined) return cached;

    return this.dedupe(cacheKey, async () => {
      const payload = await this.requestAmap(AMAP_PLACE_TEXT_URL, {
        key,
        keywords,
        page_size: String(pageSize),
        page_num: '1',
      });
      const rows = payload ? this.readSearchResults(payload) : [];
      if (payload) this.searchCache.set(cacheKey, rows);
      return rows;
    });
  }

  /** 同 key 的并发请求共用一个在途 Promise。 */
  private async dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const request = run().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  /**
   * 打一次高德。网络失败、超时、HTTP 非 2xx、业务 status 非 1 一律返回 null ——
   * 调用方只需要区分「有结果」和「没有」。
   */
  private async requestAmap(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown> | null> {
    const operation =
      endpoint === AMAP_REGEO_URL ? 'reverse_geocode' : 'place_search';
    const url = new URL(endpoint);
    Object.entries(params).forEach(([name, value]) => {
      url.searchParams.set(name, value);
    });

    try {
      const response = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        attemptDiagnostic(() =>
          this.logger.warn({
            event: 'geo_http_failed',
            operation,
            statusCode: response.status,
          }),
        );
        return null;
      }
      const payload = asRecord(await response.json());
      if (!payload) return null;
      if (payload.status !== '1') {
        // Provider prose can echo input. Keep only its bounded numeric code.
        const upstreamCode =
          typeof payload.infocode === 'string' &&
          /^\d{5}$/.test(payload.infocode)
            ? payload.infocode
            : undefined;
        attemptDiagnostic(() =>
          this.logger.warn({
            event: 'geo_provider_rejected',
            operation,
            upstreamCode,
          }),
        );
        return null;
      }
      return payload;
    } catch (error) {
      attemptDiagnostic(() =>
        this.logger.warn(
          sanitizeLogValue({ event: 'geo_request_failed', operation, error }),
        ),
      );
      return null;
    }
  }

  private readReverseResult(
    payload: Record<string, unknown>,
    latitude: number,
    longitude: number,
  ): GeocodedPlace | null {
    const regeocode = asRecord(payload.regeocode);
    const formattedAddress = readString(regeocode, 'formatted_address');
    const pois = Array.isArray(regeocode?.pois) ? regeocode.pois : [];
    const nearestPoi = asRecord(pois[0]);
    const addressComponent = asRecord(regeocode?.addressComponent);

    // 标题优先用最近的 POI（「深圳市民中心」这种），退到街道/乡镇，最后退到全址。
    const title =
      readString(nearestPoi, 'name') ||
      readString(addressComponent, 'township') ||
      formattedAddress;
    if (!title) return null;

    return {
      name: title,
      display_name: formattedAddress || title,
      lat: String(latitude),
      lon: String(longitude),
    };
  }

  private readSearchResults(payload: Record<string, unknown>): GeocodedPlace[] {
    const pois = Array.isArray(payload.pois) ? payload.pois : [];
    const rows: GeocodedPlace[] = [];

    for (const entry of pois) {
      const poi = asRecord(entry);
      const name = readString(poi, 'name');
      const location = parseAmapLocation(readString(poi, 'location'));
      if (!name || !location) continue;

      const wgs84 = gcj02ToWgs84(location.latitude, location.longitude);
      if (!wgs84) continue;

      // 拼成人读得懂的全址：省市区 + 门牌。高德的 address 只有街道门牌那一段。
      const fullAddress = [
        readString(poi, 'pname'),
        readString(poi, 'cityname'),
        readString(poi, 'adname'),
        readString(poi, 'address'),
      ]
        .filter(Boolean)
        .join('');

      rows.push({
        name,
        display_name: fullAddress || name,
        lat: String(wgs84.latitude),
        lon: String(wgs84.longitude),
      });
    }
    return rows;
  }
}
