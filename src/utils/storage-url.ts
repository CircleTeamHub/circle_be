import { BadRequestException } from '@nestjs/common';

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
