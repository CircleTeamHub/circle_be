import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateTempChatDto } from './create-temp-chat.dto';
import { GuestPresignDto, GUEST_VIDEO_MAX_BYTES } from './guest-presign.dto';
import { JoinTempChatDto } from './join-temp-chat.dto';

const errKeys = (obj: unknown, cls: any) =>
  validateSync(plainToInstance(cls, obj)).map((e) => e.property);

describe('CreateTempChatDto', () => {
  it('accepts empty body (all optional, defaults applied later)', () => {
    expect(errKeys({}, CreateTempChatDto)).toEqual([]);
  });
  it('rejects ttl below 30', () => {
    expect(errKeys({ ttlMinutes: 10 }, CreateTempChatDto)).toContain(
      'ttlMinutes',
    );
  });
  it('rejects ttl above 10080', () => {
    expect(errKeys({ ttlMinutes: 99999 }, CreateTempChatDto)).toContain(
      'ttlMinutes',
    );
  });
  it('rejects maxMembers above 50', () => {
    expect(errKeys({ maxMembers: 51 }, CreateTempChatDto)).toContain(
      'maxMembers',
    );
  });
  it('rejects maxMembers below 2', () => {
    expect(errKeys({ maxMembers: 1 }, CreateTempChatDto)).toContain(
      'maxMembers',
    );
  });
  it('rejects title longer than 30', () => {
    expect(errKeys({ title: 'x'.repeat(31) }, CreateTempChatDto)).toContain(
      'title',
    );
  });
});

describe('JoinTempChatDto', () => {
  it('accepts empty body', () => {
    expect(errKeys({}, JoinTempChatDto)).toEqual([]);
  });
  it('rejects displayName longer than 20', () => {
    expect(errKeys({ displayName: 'x'.repeat(21) }, JoinTempChatDto)).toContain(
      'displayName',
    );
  });
});

describe('GuestPresignDto', () => {
  const valid = {
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1024,
  };

  it('accepts a safe Unicode filename', () => {
    expect(
      errKeys({ ...valid, filename: '测试图片.png' }, GuestPresignDto),
    ).toEqual([]);
  });

  it.each([
    '../photo.png',
    'folder/photo.png',
    'folder\\photo.png',
    'bad\u0000.png',
  ])('rejects a path-like or control-character filename: %s', (filename) => {
    expect(errKeys({ ...valid, filename }, GuestPresignDto)).toContain(
      'filename',
    );
  });

  it('rejects unsupported image MIME types', () => {
    expect(
      errKeys({ ...valid, contentType: 'image/avif' }, GuestPresignDto),
    ).toContain('contentType');
  });

  it.each(['video/mp4', 'video/quicktime', 'video/x-m4v'])(
    'accepts supported guest video MIME type %s',
    (contentType) => {
      expect(
        errKeys(
          {
            filename:
              contentType === 'video/quicktime' ? 'clip.mov' : 'clip.mp4',
            contentType,
            sizeBytes: GUEST_VIDEO_MAX_BYTES,
          },
          GuestPresignDto,
        ),
      ).toEqual([]);
    },
  );

  it('rejects a guest video above the 50MB limit', () => {
    expect(
      errKeys(
        {
          filename: 'clip.mp4',
          contentType: 'video/mp4',
          sizeBytes: GUEST_VIDEO_MAX_BYTES + 1,
        },
        GuestPresignDto,
      ),
    ).toContain('sizeBytes');
  });
});
