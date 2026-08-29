import {
  assertUrlsFromStorage,
  buildStoragePublicObjectBase,
  storagePublicObjectBaseFromConfig,
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
});
