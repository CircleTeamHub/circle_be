import sharp from 'sharp';
import { renderNoteLongImage } from './note-long-image';

const picture = (background: string, width = 200, height = 100) =>
  sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();

test('renders every image into a single full-width PNG without cropping portraits', async () => {
  const images = {
    red: await picture('#ff0000'),
    blue: await picture('#0000ff', 100, 200),
  };
  const load = jest.fn(async (key: string) => images[key]);
  const result = await renderNoteLongImage(
    '完整笔记',
    [
      { type: 'media', label: '图片', key: 'red' },
      { type: 'text', text: '中间正文' },
      { type: 'media', label: '图片', key: 'blue' },
    ],
    load,
  );
  expect(result.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const { data, info } = await sharp(result)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(1320);
  const centerRows = Array.from({ length: info.height }, (_, y) => {
    const offset = (y * info.width + info.width / 2) * info.channels;
    return Array.from(data.subarray(offset, offset + 3));
  });
  const redRows = centerRows.flatMap((rgb, y) =>
    rgb[0] > 240 && rgb[2] < 10 ? [y] : [],
  );
  const blueRows = centerRows.flatMap((rgb, y) =>
    rgb[2] > 240 && rgb[0] < 10 ? [y] : [],
  );
  expect(redRows.length).toBeGreaterThan(600);
  expect(blueRows.length).toBeGreaterThan(2400);
  expect(Math.max(...redRows)).toBeLessThan(Math.min(...blueRows));
  expect(load.mock.calls).toEqual([['red'], ['blue']]);
});

test('wraps long Chinese and unbroken Latin text and escapes markup', async () => {
  const load = jest.fn();
  const short = await renderNoteLongImage(
    '标题',
    [{ type: 'text', text: '短正文' }],
    load,
  );
  const long = await renderNoteLongImage(
    '<b>标题 & 原文</b>',
    [
      {
        type: 'text',
        text: '完整中文内容'.repeat(80) + '\n' + 'abcdefghij'.repeat(80),
      },
    ],
    load,
  );
  expect((await sharp(long).metadata()).height).toBeGreaterThan(
    (await sharp(short).metadata()).height! + 500,
  );
  expect(load).not.toHaveBeenCalled();
});

test('renders a video poster and keeps recordings and posterless videos as static cards', async () => {
  const load = jest.fn(async () => picture('#009900'));
  const output = await renderNoteLongImage(
    '视频笔记',
    [
      { type: 'media', label: '视频', key: 'poster', video: true },
      { type: 'media', label: '展示视频', key: null, video: true },
      { type: 'media', label: '录音', key: null },
    ],
    load,
  );
  expect((await sharp(output).metadata()).format).toBe('png');
  expect(load.mock.calls).toEqual([['poster']]);
});

test('fails instead of silently omitting an unavailable picture', async () => {
  const failure = new Error('object unavailable');
  await expect(
    renderNoteLongImage(
      '笔记',
      [{ type: 'media', label: '图片', key: 'missing' }],
      async () => {
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
});

test('rejects images that would exceed the output pixel budget before resizing', async () => {
  const tall = await picture('#fff', 1, 1000);
  await expect(
    renderNoteLongImage(
      '笔记',
      [{ type: 'media', label: '图片', key: 'tall' }],
      async () => tall,
    ),
  ).rejects.toMatchObject({
    response: { errorCode: 'NOTE_EXPORT_TOTAL_TOO_LARGE' },
  });
});
