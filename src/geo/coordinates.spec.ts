import { gcj02ToWgs84, isOutOfChina, wgs84ToGcj02 } from './coordinates';

/** 两点间的近似米距，够用来断言「偏了一个街区」还是「几乎没动」。 */
function metersApart(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const latitudeMeters = (a.latitude - b.latitude) * 111_320;
  const longitudeMeters =
    (a.longitude - b.longitude) *
    111_320 *
    Math.cos((a.latitude * Math.PI) / 180);
  return Math.hypot(latitudeMeters, longitudeMeters);
}

describe('isOutOfChina', () => {
  it.each([
    ['深圳', 22.545, 114.0575],
    ['北京', 39.9087, 116.3975],
  ])('把 %s 判为境内', (_name, latitude, longitude) => {
    expect(isOutOfChina(latitude, longitude)).toBe(false);
  });

  it.each([
    ['圣何塞', 37.32698, -121.88435],
    ['东京', 35.6812, 139.7671],
  ])('把 %s 判为境外', (_name, latitude, longitude) => {
    expect(isOutOfChina(latitude, longitude)).toBe(true);
  });
});

describe('wgs84ToGcj02', () => {
  it('把境内坐标推开一个街区的量级', () => {
    const wgs84 = { latitude: 22.545, longitude: 114.0575 };
    const gcj02 = wgs84ToGcj02(wgs84.latitude, wgs84.longitude);

    expect(gcj02).not.toBeNull();
    // 深圳市民中心实测偏移约 607 米；给一个宽区间，只钉住量级。
    expect(metersApart(wgs84, gcj02!)).toBeGreaterThan(300);
    expect(metersApart(wgs84, gcj02!)).toBeLessThan(900);
  });

  it('境外坐标原样返回', () => {
    const sanJose = wgs84ToGcj02(37.32698, -121.88435);

    expect(sanJose).toEqual({ latitude: 37.32698, longitude: -121.88435 });
  });

  it('非法坐标返回 null', () => {
    expect(wgs84ToGcj02(91, 113)).toBeNull();
    expect(wgs84ToGcj02(22, Number.NaN)).toBeNull();
  });
});

describe('gcj02ToWgs84', () => {
  it.each([
    ['深圳', 22.545, 114.0575],
    ['北京', 39.9087, 116.3975],
    ['乌鲁木齐', 43.8256, 87.6168],
  ])('往返 %s 能回到原点（亚米级）', (_name, latitude, longitude) => {
    const gcj02 = wgs84ToGcj02(latitude, longitude)!;
    const roundTrip = gcj02ToWgs84(gcj02.latitude, gcj02.longitude)!;

    // 迭代反解的目标是「肉眼无差」，1 米以内足够——图钉落在同一个门牌上。
    expect(metersApart({ latitude, longitude }, roundTrip)).toBeLessThan(1);
  });

  it('境外坐标原样返回', () => {
    expect(gcj02ToWgs84(35.6812, 139.7671)).toEqual({
      latitude: 35.6812,
      longitude: 139.7671,
    });
  });

  it('非法坐标返回 null', () => {
    expect(gcj02ToWgs84(-91, 113)).toBeNull();
    expect(gcj02ToWgs84(Number.POSITIVE_INFINITY, 113)).toBeNull();
  });
});
