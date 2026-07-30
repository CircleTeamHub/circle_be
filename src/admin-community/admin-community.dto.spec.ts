import { BadRequestException } from '@nestjs/common';
import { requireIdempotencyKey } from './admin-community.dto';

describe('requireIdempotencyKey', () => {
  it('accepts a UUID v4 request key', () => {
    const key = '95f05612-5448-49df-b5f8-065dc936bce5';

    expect(requireIdempotencyKey(key)).toBe(key);
  });

  it.each([undefined, '', 'request-1', '95f05612-5448-19df-b5f8-065dc936bce5'])(
    'rejects an invalid request key: %p',
    (value) => {
      expect(() => requireIdempotencyKey(value)).toThrow(BadRequestException);
    },
  );
});
