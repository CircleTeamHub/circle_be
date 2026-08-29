import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

export type ObjectStoreStatus =
  | 'ok'
  | 'policy-unconfirmed'
  | 'external-unverified'
  | 'disabled';

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

export function buildStoragePublicObjectBase(
  publicUrl: string,
  bucket: string,
  forcePathStyle: boolean,
): string {
  const normalized = stripTrailingSlashes(publicUrl);
  if (forcePathStyle) return `${normalized}/${bucket}`;

  const url = new URL(normalized);
  if (!url.hostname.startsWith(`${bucket}.`)) {
    url.hostname = `${bucket}.${url.hostname}`;
  }
  return stripTrailingSlashes(url.toString());
}

export function storagePublicObjectBaseFromConfig(
  config: Pick<ConfigService, 'get'>,
): string | null {
  const publicUrl =
    config.get<string>('MINIO_PUBLIC_URL') ??
    config.get<string>('MINIO_ENDPOINT');
  if (!publicUrl) return null;
  const bucket = config.get<string>('MINIO_BUCKET') ?? 'circle';
  const configuredPathStyle = config.get<boolean | string>(
    'OBJECT_STORAGE_FORCE_PATH_STYLE',
  );
  let forcePathStyle = true;
  if (typeof configuredPathStyle === 'boolean') {
    forcePathStyle = configuredPathStyle;
  } else if (typeof configuredPathStyle === 'string') {
    forcePathStyle = configuredPathStyle.toLowerCase() === 'true';
  }
  return buildStoragePublicObjectBase(publicUrl, bucket, forcePathStyle);
}

/**
 * True if `url` is served from `publicUrl`'s origin.
 *
 * The prefix must be followed by `/` (or match exactly) — a bare
 * `startsWith` check would let `https://host.attacker.com` pass when the
 * storage origin is `https://host`.
 */
export function isUrlFromStorage(url: string, publicUrl: string): boolean {
  const prefix = publicUrl.replace(/\/$/, '');
  return url === prefix || url.startsWith(`${prefix}/`);
}

/**
 * Throws `BadRequestException` if any non-empty url is not served from this
 * application's own storage (`publicUrl`). When `publicUrl` is null/empty the
 * check is skipped — storage (MinIO/S3) is unconfigured, upload is disabled.
 *
 * Centralizes the guard that user / note / circle / circle-plaza each needed:
 * client-supplied URLs that get rendered to other users must be pinned to
 * own-origin, otherwise they are tracking / phishing vectors.
 */
export function assertUrlsFromStorage(
  urls: ReadonlyArray<string | null | undefined>,
  publicUrl: string | null | undefined,
  label = 'url',
): void {
  if (!publicUrl) return;
  for (const url of urls) {
    if (typeof url === 'string' && url && !isUrlFromStorage(url, publicUrl)) {
      throw new BadRequestException(
        `${label} must be served from this application's storage`,
      );
    }
  }
}
