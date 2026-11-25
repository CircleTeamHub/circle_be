import { PayloadTooLargeException } from '@nestjs/common';
import sharp, { type OverlayOptions } from 'sharp';
import { NoteErrorCode } from 'src/common/app-error-codes';

export type NoteLongImagePart =
  | { type: 'text'; text: string }
  | { type: 'media'; label: string; key: string | null; video?: boolean };

const WIDTH = 1320;
const PADDING = 30;
const CONTENT_WIDTH = WIDTH - PADDING * 2;
// Bounds decoded/output memory, rather than silently omitting later pictures.
const MAX_PIXELS = 60_000_000;

export async function renderNoteLongImage(
  title: string,
  parts: NoteLongImagePart[],
  loadImage: (key: string) => Promise<Buffer>,
): Promise<Buffer> {
  const layers: OverlayOptions[] = [];
  let cursor = PADDING;
  const checkHeight = (height: number) => {
    if (WIDTH * height > MAX_PIXELS) {
      throw new PayloadTooLargeException({
        message: 'Note is too long to export as one image',
        errorCode: NoteErrorCode.ExportTotalTooLarge,
      });
    }
  };
  const textImage = (
    text: string,
    size: number,
    color = '#111827',
    bold = false,
  ) => {
    const escaped = text
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(
        /[&<>]/g,
        (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!,
      );
    return sharp({
      text: {
        text: `<span foreground="${color}">${escaped}</span>`,
        font: `sans ${bold ? 'bold ' : ''}${size}`,
        width: CONTENT_WIDTH,
        wrap: 'word-char',
        spacing: 12,
        rgba: true,
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
  };
  const appendText = async (
    text: string,
    size = 38,
    color = '#111827',
    bold = false,
  ) => {
    if (!text.trim()) return;
    const { data, info } = await textImage(text, size, color, bold);
    checkHeight(cursor + info.height + PADDING);
    layers.push({ input: data, left: PADDING, top: cursor });
    cursor += info.height + 28;
  };

  await appendText(title, 48, '#111827', true);
  layers.push({
    input: Buffer.from(
      `<svg width="${CONTENT_WIDTH}" height="3"><path d="M0 1h${CONTENT_WIDTH}" stroke="#cbd0d9" stroke-width="2" stroke-dasharray="16 12"/></svg>`,
    ),
    left: PADDING,
    top: cursor,
  });
  cursor += 30;

  for (const part of parts) {
    if (part.type === 'text') {
      await appendText(part.text);
      continue;
    }
    let height = 180;
    let input: Buffer;
    if (part.key) {
      const bytes = await loadImage(part.key);
      const image = sharp(bytes, { limitInputPixels: MAX_PIXELS });
      const meta = await image.metadata();
      const rotated = meta.orientation >= 5;
      const width = rotated ? meta.height : meta.width;
      const sourceHeight = rotated ? meta.width : meta.height;
      checkHeight(
        cursor + Math.ceil((CONTENT_WIDTH * sourceHeight) / width) + PADDING,
      );
      const result = await image
        .rotate()
        .resize({ width: CONTENT_WIDTH })
        .png()
        .toBuffer({ resolveWithObject: true });
      input = result.data;
      height = result.info.height;
    } else {
      input = await sharp({
        create: {
          width: CONTENT_WIDTH,
          height,
          channels: 3,
          background: '#e8ebf1',
        },
      })
        .png()
        .toBuffer();
    }
    checkHeight(cursor + height + PADDING);
    layers.push({ input, left: PADDING, top: cursor });

    const badge = await textImage(part.label, 30, '#ffffff');
    const badgeWidth = Math.min(CONTENT_WIDTH, badge.info.width + 28);
    const badgeHeight = badge.info.height + 20;
    let color = '#ad4dc1';
    if (part.video) color = '#2787c8';
    if (part.label === '录音') color = '#6d8799';
    layers.push({
      input: Buffer.from(
        `<svg width="${badgeWidth}" height="${badgeHeight}"><rect width="100%" height="100%" rx="8" fill="${color}"/></svg>`,
      ),
      left: PADDING,
      top: cursor,
    });
    layers.push({ input: badge.data, left: PADDING + 14, top: cursor + 10 });
    if (part.video) {
      layers.push({
        input: Buffer.from(
          '<svg width="100" height="100"><circle cx="50" cy="50" r="44" fill="#000" fill-opacity=".25" stroke="#fff" stroke-width="5"/><path d="M40 28L73 50L40 72Z" fill="#fff"/></svg>',
        ),
        left: Math.round((WIDTH - 100) / 2),
        top: cursor + Math.round((height - 100) / 2),
      });
    }
    cursor += height + 22;
  }

  const footer = await textImage('- END -', 30, '#9ca3af');
  layers.push({
    input: footer.data,
    left: Math.round((WIDTH - footer.info.width) / 2),
    top: cursor + 12,
  });
  const height = cursor + footer.info.height + PADDING + 12;
  checkHeight(height);
  return sharp({
    create: { width: WIDTH, height, channels: 3, background: '#f6f7fb' },
  })
    .composite(layers)
    .png()
    .toBuffer();
}
