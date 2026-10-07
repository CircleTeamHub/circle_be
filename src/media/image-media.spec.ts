import { buildImageMedia } from './image-media';

describe('buildImageMedia', () => {
  it('keeps the legacy original URL and emits stable size fields', () => {
    expect(buildImageMedia(['https://media.example/a.jpg'])).toEqual([
      {
        thumb: 'https://media.example/a.jpg',
        preview: 'https://media.example/a.jpg',
        original: 'https://media.example/a.jpg',
      },
    ]);
  });

  it('uses a configured image gateway without exposing a raw original in the transform URL', () => {
    const result = buildImageMedia(
      ['https://media.example/a photo.jpg'],
      'https://img.example/resize?url={url}&width={width}',
    );
    expect(result[0]).toEqual({
      thumb:
        'https://img.example/resize?url=https%3A%2F%2Fmedia.example%2Fa%20photo.jpg&width=480',
      preview:
        'https://img.example/resize?url=https%3A%2F%2Fmedia.example%2Fa%20photo.jpg&width=1280',
      original: 'https://media.example/a photo.jpg',
    });
  });

  it('falls back safely when the template is incomplete or not http(s)', () => {
    expect(
      buildImageMedia(['https://media.example/a.jpg'], 'file://{url}/{width}'),
    ).toEqual([
      {
        thumb: 'https://media.example/a.jpg',
        preview: 'https://media.example/a.jpg',
        original: 'https://media.example/a.jpg',
      },
    ]);
  });
});
