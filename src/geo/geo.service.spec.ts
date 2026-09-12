import { ConfigService } from '@nestjs/config';
import { wgs84ToGcj02 } from './coordinates';
import { GeoService } from './geo.service';

const SHENZHEN = { latitude: 22.545, longitude: 114.0575 };
const SAN_JOSE = { latitude: 37.32698, longitude: -121.88435 };

function buildService(key = 'test-amap-key'): GeoService {
  const config = {
    get: (name: string) => (name === 'AMAP_WEB_SERVICE_KEY' ? key : undefined),
  } as unknown as ConfigService;
  return new GeoService(config);
}

function mockFetchOnce(payload: unknown, ok = true) {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  } as Response);
}

const REGEO_OK = {
  status: '1',
  info: 'OK',
  regeocode: {
    formatted_address: '广东省深圳市福田区福中三路市民中心',
    addressComponent: { township: '莲花街道' },
    pois: [{ name: '深圳市民中心', location: '114.0637,114.0637' }],
  },
};

const PLACE_OK = {
  status: '1',
  info: 'OK',
  pois: [
    {
      name: '深圳市民中心',
      address: '福中三路',
      location: '114.06369,22.54699',
      pname: '广东省',
      cityname: '深圳市',
      adname: '福田区',
    },
  ],
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GeoService.reverse', () => {
  it('把 WGS-84 加偏成 GCJ-02 再喂给高德，且按经度在前的顺序', async () => {
    const fetchSpy = mockFetchOnce(REGEO_OK);

    await buildService().reverse(SHENZHEN.latitude, SHENZHEN.longitude);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const requested = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(requested.origin + requested.pathname).toBe(
      'https://restapi.amap.com/v3/geocode/regeo',
    );
    const [longitude, latitude] = requested.searchParams
      .get('location')!
      .split(',')
      .map(Number);
    // 经度在前、纬度在后；两者都被推开了，说明加偏真的发生了。
    expect(longitude).toBeGreaterThan(SHENZHEN.longitude);
    expect(latitude).not.toBe(SHENZHEN.latitude);
    expect(Math.abs(latitude - SHENZHEN.latitude)).toBeLessThan(0.01);
  });

  it('key 不出现在返回里，但必须出现在请求里', async () => {
    const fetchSpy = mockFetchOnce(REGEO_OK);

    const place = await buildService().reverse(
      SHENZHEN.latitude,
      SHENZHEN.longitude,
    );

    const requested = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(requested.searchParams.get('key')).toBe('test-amap-key');
    expect(JSON.stringify(place)).not.toContain('test-amap-key');
  });

  it('用 POI 名做标题，用结构化地址做全称', async () => {
    mockFetchOnce(REGEO_OK);

    const place = await buildService().reverse(
      SHENZHEN.latitude,
      SHENZHEN.longitude,
    );

    expect(place).toMatchObject({
      name: '深圳市民中心',
      display_name: '广东省深圳市福田区福中三路市民中心',
    });
  });

  it('同一个点只打一次高德，第二次走缓存', async () => {
    const fetchSpy = mockFetchOnce(REGEO_OK);
    const service = buildService();

    await service.reverse(SHENZHEN.latitude, SHENZHEN.longitude);
    await service.reverse(SHENZHEN.latitude, SHENZHEN.longitude);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('境外坐标不打高德——那边没有数据，白跑一趟还烧配额', async () => {
    const fetchSpy = mockFetchOnce(REGEO_OK);

    const place = await buildService().reverse(
      SAN_JOSE.latitude,
      SAN_JOSE.longitude,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(place).toBeNull();
  });

  it('没配 key 时直接返回空，不发请求', async () => {
    const fetchSpy = mockFetchOnce(REGEO_OK);

    const place = await buildService('').reverse(
      SHENZHEN.latitude,
      SHENZHEN.longitude,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(place).toBeNull();
  });

  it.each([
    ['高德业务失败', { status: '0', info: 'INVALID_USER_KEY' }],
    ['响应结构不认识', { status: '1', regeocode: null }],
  ])('%s 时返回空而不是抛错', async (_name, payload) => {
    mockFetchOnce(payload);

    await expect(
      buildService().reverse(SHENZHEN.latitude, SHENZHEN.longitude),
    ).resolves.toBeNull();
  });

  it('网络异常时返回空而不是抛错', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(
      buildService().reverse(SHENZHEN.latitude, SHENZHEN.longitude),
    ).resolves.toBeNull();
  });

  it('失败不写缓存，下次还能再试', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('ETIMEDOUT'));
    const service = buildService();

    await service.reverse(SHENZHEN.latitude, SHENZHEN.longitude);
    await service.reverse(SHENZHEN.latitude, SHENZHEN.longitude);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('GeoService.search', () => {
  it('把高德的 GCJ-02 结果减偏回 WGS-84', async () => {
    mockFetchOnce(PLACE_OK);

    const [row] = await buildService().search('市民中心', 5);

    expect(row.name).toBe('深圳市民中心');
    expect(row.display_name).toContain('深圳市');
    // 高德给的是 GCJ-02 的 114.06369,22.54699。方向随地点而变，这里钉住真正的
    // 性质：减偏的结果重新加偏，要能回到高德原本给的那个点。
    const roundTrip = wgs84ToGcj02(Number(row.lat), Number(row.lon))!;
    expect(roundTrip.longitude).toBeCloseTo(114.06369, 5);
    expect(roundTrip.latitude).toBeCloseTo(22.54699, 5);
    // 而且确实动过——不是把 GCJ-02 原样透出来。
    expect(Number(row.lat)).not.toBeCloseTo(22.54699, 5);
  });

  it('limit 传给高德的 page_size，并夹在合法区间内', async () => {
    const fetchSpy = mockFetchOnce(PLACE_OK);

    await buildService().search('市民中心', 999);

    const requested = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(Number(requested.searchParams.get('page_size'))).toBeLessThanOrEqual(
      25,
    );
  });

  it('空关键词不发请求', async () => {
    const fetchSpy = mockFetchOnce(PLACE_OK);

    await expect(buildService().search('   ', 5)).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('坐标残缺的条目被丢掉，不会变成 NaN 图钉', async () => {
    mockFetchOnce({
      status: '1',
      pois: [
        { name: '坏点', address: '', location: 'not-a-coordinate' },
        ...PLACE_OK.pois,
      ],
    });

    const rows = await buildService().search('市民中心', 5);

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('深圳市民中心');
  });

  it('高德失败时返回空数组而不是抛错', async () => {
    mockFetchOnce({ status: '0', info: 'DAILY_QUERY_OVER_LIMIT' });

    await expect(buildService().search('市民中心', 5)).resolves.toEqual([]);
  });
});
