import { BadRequestException } from '@nestjs/common';
import { ParseUserIdPipe } from './parse-user-id.pipe';

describe('ParseUserIdPipe', () => {
  const pipe = new ParseUserIdPipe();
  it('accepts persisted non-RFC UUIDs and normalizes legacy aliases', () => {
    const id = 'aabbccdd-1122-0000-0000-123456789abc';
    expect(pipe.transform(id)).toBe(id);
    expect(pipe.transform('AABBCCDD112200000000123456789ABC')).toBe(id);
  });
  it.each(['not-an-id', '', 'aabbccdd1122'])(
    'rejects invalid input %s',
    (id) => {
      expect(() => pipe.transform(id)).toThrow(BadRequestException);
    },
  );
});
