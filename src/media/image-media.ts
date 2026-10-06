/**
 * Public image projection used by feeds.
 *
 * The database keeps the legacy `images` array so old clients and storage
 * audits remain compatible. A deployment may point MEDIA_IMAGE_TRANSFORM_URL
 * at its image gateway, using `{url}` and `{width}` placeholders, for example:
 *   https://img.example.com/resize?url={url}&width={width}
 *
 * Without a configured gateway the projection deliberately uses the original
 * URL for every size. That keeps the contract forward compatible without
 * pretending an object store can resize bytes on its own.
 */
export interface ImageMediaVariant {
  thumb: string;
  preview: string;
  original: string;
}

const THUMB_WIDTH = 480;
const PREVIEW_WIDTH = 1280;

function transformedUrl(
  original: string,
  width: number,
  template: string | undefined,
): string {
  if (!template?.trim()) return original;
  const raw = template.trim();
  if (!raw.includes('{url}') || !raw.includes('{width}')) return original;
  try {
    const candidate = raw
      .split('{url}')
      .join(encodeURIComponent(original))
      .split('{width}')
      .join(String(width));
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return original;
    }
    return parsed.toString();
  } catch {
    return original;
  }
}

export function buildImageMedia(
  images: readonly string[] | null | undefined,
  transformTemplate?: string | null,
): ImageMediaVariant[] {
  const template = transformTemplate?.trim() || undefined;
  return (images ?? [])
    .filter(
      (image): image is string => typeof image === 'string' && image.length > 0,
    )
    .map((original) => ({
      thumb: transformedUrl(original, THUMB_WIDTH, template),
      preview: transformedUrl(original, PREVIEW_WIDTH, template),
      original,
    }));
}
