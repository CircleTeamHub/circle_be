import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateTraceCommentDto } from './trace.dto';

describe('CreateTraceCommentDto', () => {
  const uuid = (suffix: string) =>
    `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;

  it('accepts up to 20 distinct mentioned user UUIDs', () => {
    const dto = plainToInstance(CreateTraceCommentDto, {
      content: 'hello',
      mentionedUserIds: Array.from({ length: 20 }, (_, index) =>
        uuid(String(index + 1)),
      ),
    });

    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects non-UUID mentioned user IDs', () => {
    const dto = plainToInstance(CreateTraceCommentDto, {
      content: 'hello',
      mentionedUserIds: ['not-a-uuid'],
    });

    expect(validateSync(dto).map((error) => error.property)).toContain(
      'mentionedUserIds',
    );
  });

  it('rejects more than 20 mentioned users', () => {
    const dto = plainToInstance(CreateTraceCommentDto, {
      content: 'hello',
      mentionedUserIds: Array.from({ length: 21 }, (_, index) =>
        uuid(String(index + 1)),
      ),
    });

    expect(validateSync(dto).map((error) => error.property)).toContain(
      'mentionedUserIds',
    );
  });

  it('rejects duplicate mentioned user IDs', () => {
    const duplicate = uuid('1');
    const dto = plainToInstance(CreateTraceCommentDto, {
      content: 'hello',
      mentionedUserIds: [duplicate, duplicate],
    });

    expect(validateSync(dto).map((error) => error.property)).toContain(
      'mentionedUserIds',
    );
  });
});
