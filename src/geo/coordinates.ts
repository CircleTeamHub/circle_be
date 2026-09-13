/**
 * WGS-84 ↔ GCJ-02（火星坐标）互转。
 *
 * 为什么服务端需要这个：App 这一侧从采集（系统定位返回原始 GPS）、入库到发出去的
 * 位置消息，口径**全是 WGS-84**；而高德以及任何在国内落地的地图服务，读到和吐出的
 * 坐标都按 GCJ-02 解释。两者在国内差 300～600 米——正好一个街区，图钉会落到隔壁楼。
 *
 * 转换只发生在**调用高德的这一层边界上**：进去前加偏，拿回来的坐标减偏。这样存储
 * 口径始终是 WGS-84，历史位置消息不需要任何迁移。
 */

const GCJ02_A = 6378245.0;
const GCJ02_EE = 0.00669342162296594323;

export type Coordinate = {
  latitude: number;
  longitude: number;
};

function isUsable(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/**
 * 加偏只在国境内定义。境外照搬公式会把坐标推歪几公里，所以先过这道闸门——
 * 这也让「用户在境外」这种情况自动退化成不做任何转换。
 *
 * 这是粗粒度的矩形判断（与前端 location-map.ts 保持同一套边界），国境线附近
 * 几百米的误判无所谓：那一带本来就没有稳定的加偏定义。
 */
export function isOutOfChina(latitude: number, longitude: number): boolean {
  return (
    longitude < 72.004 ||
    longitude > 137.8347 ||
    latitude < 0.8293 ||
    latitude > 55.8271
  );
}

function transformLatitude(x: number, y: number): number {
  let result =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  result +=
    ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  result +=
    ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  result +=
    ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) *
      2) /
    3;
  return result;
}

function transformLongitude(x: number, y: number): number {
  let result =
    300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  result +=
    ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  result +=
    ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  result +=
    ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) *
      2) /
    3;
  return result;
}

/** 正向加偏的位移量，反解时要反复用到。 */
function offsetFor(latitude: number, longitude: number): Coordinate {
  const deltaLatitude = transformLatitude(longitude - 105, latitude - 35);
  const deltaLongitude = transformLongitude(longitude - 105, latitude - 35);
  const radians = (latitude * Math.PI) / 180;
  const magic = 1 - GCJ02_EE * Math.sin(radians) ** 2;
  const sqrtMagic = Math.sqrt(magic);
  return {
    latitude:
      (deltaLatitude * 180) /
      (((GCJ02_A * (1 - GCJ02_EE)) / (magic * sqrtMagic)) * Math.PI),
    longitude:
      (deltaLongitude * 180) /
      ((GCJ02_A / sqrtMagic) * Math.cos(radians) * Math.PI),
  };
}

/** WGS-84 → GCJ-02。境外坐标原样返回，非法坐标返回 null。 */
export function wgs84ToGcj02(
  latitude: number,
  longitude: number,
): Coordinate | null {
  if (!isUsable(latitude, longitude)) return null;
  if (isOutOfChina(latitude, longitude)) return { latitude, longitude };

  const offset = offsetFor(latitude, longitude);
  return {
    latitude: latitude + offset.latitude,
    longitude: longitude + offset.longitude,
  };
}

/**
 * GCJ-02 → WGS-84。境外坐标原样返回，非法坐标返回 null。
 *
 * 加偏公式没有闭式反解，用不动点迭代逼近：拿当前猜测正向加偏，把与目标的差额
 * 补回猜测里。收敛极快——三轮就到厘米级，这里跑满五轮留足余量。
 */
export function gcj02ToWgs84(
  latitude: number,
  longitude: number,
): Coordinate | null {
  if (!isUsable(latitude, longitude)) return null;
  if (isOutOfChina(latitude, longitude)) return { latitude, longitude };

  let guessLatitude = latitude;
  let guessLongitude = longitude;
  for (let round = 0; round < 5; round += 1) {
    const offset = offsetFor(guessLatitude, guessLongitude);
    guessLatitude = latitude - offset.latitude;
    guessLongitude = longitude - offset.longitude;
  }
  return { latitude: guessLatitude, longitude: guessLongitude };
}
