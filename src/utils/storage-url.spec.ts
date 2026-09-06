import {
  assertUrlsFromStorage,
  buildStoragePublicObjectBase,
  isUrlFromStorage,
  storagePublicObjectBaseFromConfig,
  storagePublicObjectBasesFromConfig,
} from './storage-url';

describe('storage URL helpers', () => {
  it('builds the same virtual-hosted public base used by COS presign', () => {
    const base = buildStoragePublicObjectBase(
      'https://cos.ap-tokyo.myqcloud.com',
      'windnote-1234567890',
      false,
    );

    expect(base).toBe('https://windnote-1234567890.cos.ap-tokyo.myqcloud.com');
    expect(() =>
      assertUrlsFromStorage(
        [`${base}/avatars/user-1/me.png`],
        base,
        'profile image url',
      ),
    ).not.toThrow();
  });

  it('does not accept a lookalike subdomain', () => {
    expect(() =>
      assertUrlsFromStorage(
        [
          'https://windnote-1234567890.cos.ap-tokyo.myqcloud.com.attacker.test/x',
        ],
        'https://windnote-1234567890.cos.ap-tokyo.myqcloud.com',
      ),
    ).toThrow("must be served from this application's storage");
  });

  it('falls back to MINIO_ENDPOINT when no separate public URL is configured', () => {
    const config = {
      get: (key: string) =>
        ({
          MINIO_ENDPOINT: 'http://minio:9000',
          MINIO_BUCKET: 'circle',
          OBJECT_STORAGE_FORCE_PATH_STYLE: true,
        })[key],
    };

    expect(storagePublicObjectBaseFromConfig(config as never)).toBe(
      'http://minio:9000/circle',
    );
  });

  it('prefers an exact rate-limited delivery base over the signing endpoint', () => {
    const config = {
      get: (key: string) =>
        ({
          MINIO_PUBLIC_URL: 'https://cos.ap-tokyo.myqcloud.com',
          MINIO_BUCKET: 'windnote-1234567890',
          OBJECT_STORAGE_FORCE_PATH_STYLE: false,
          OBJECT_STORAGE_DELIVERY_URL: 'https://media.example.com/circle/',
        })[key],
    };

    expect(storagePublicObjectBaseFromConfig(config as never)).toBe(
      'https://media.example.com/circle',
    );
  });

  it('keeps the pre-cutover direct base recognizable alongside the delivery base', () => {
    const config = {
      get: (key: string) =>
        ({
          MINIO_PUBLIC_URL: 'https://cos.ap-tokyo.myqcloud.com',
          MINIO_BUCKET: 'windnote-1234567890',
          OBJECT_STORAGE_FORCE_PATH_STYLE: false,
          OBJECT_STORAGE_DELIVERY_URL: 'https://media.example.com/circle',
        })[key],
    };

    expect(storagePublicObjectBasesFromConfig(config as never)).toEqual([
      'https://media.example.com/circle',
      'https://windnote-1234567890.cos.ap-tokyo.myqcloud.com',
    ]);
  });

  it('does not repeat the direct base when no delivery URL is configured', () => {
    const config = {
      get: (key: string) =>
        ({
          MINIO_PUBLIC_URL: 'http://minio:9000',
          MINIO_BUCKET: 'circle',
          OBJECT_STORAGE_FORCE_PATH_STYLE: true,
        })[key],
    };

    expect(storagePublicObjectBasesFromConfig(config as never)).toEqual([
      'http://minio:9000/circle',
    ]);
  });

  it('accepts a url served from any configured base', () => {
    const bases = [
      'https://media.example.com/circle',
      'https://windnote-1234567890.cos.ap-tokyo.myqcloud.com',
    ];

    expect(
      isUrlFromStorage('https://media.example.com/circle/notes/a.jpg', bases),
    ).toBe(true);
    expect(
      isUrlFromStorage(
        'https://windnote-1234567890.cos.ap-tokyo.myqcloud.com/notes/a.jpg',
        bases,
      ),
    ).toBe(true);
    // 前缀相邻的攻击者域名仍然不算自家存储。
    expect(
      isUrlFromStorage('https://media.example.com.evil.com/x.jpg', bases),
    ).toBe(false);
    expect(isUrlFromStorage('https://media.example.com/circle', [])).toBe(
      false,
    );
  });
});
