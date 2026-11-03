import { validate } from 'class-validator';
import { CreateStickerDto } from './sticker.dto';

describe('CreateStickerDto', () => {
  it('accepts an owned upload candidate and a message UUID at the HTTP boundary', async () => {
    expect(
      await validate(
        Object.assign(new CreateStickerDto(), {
          objectKey: 'stickers/alice/photo.png',
          width: 100,
          height: 200,
        }),
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        Object.assign(new CreateStickerDto(), {
          messageId: 'b4add0e7-b7b5-4c99-9c88-d403460672d3',
        }),
      ),
    ).toHaveLength(0);
  });
  it.each([
    { messageId: 'not-a-uuid' },
    { objectKey: 'x'.repeat(513) },
    { width: 0 },
    { height: 16385 },
    { width: 1.1 },
  ])('rejects malformed source/dimensions %o', async (input) => {
    expect(
      (await validate(Object.assign(new CreateStickerDto(), input))).length,
    ).toBeGreaterThan(0);
  });
});
