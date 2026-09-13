import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateTraceCommentDto, CreateTraceDto } from './trace.dto';

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

describe('CreateTraceDto images', () => {
  const storageUrl = (n: number) =>
    `https://cdn.example.com/posts/user-1/${String(n).padStart(36, '0')}.jpg`;

  it('accepts up to 9 distinct storage URLs', () => {
    const dto = plainToInstance(CreateTraceDto, {
      content: 'hello',
      images: Array.from({ length: 9 }, (_, index) => storageUrl(index)),
    });

    expect(validateSync(dto)).toHaveLength(0);
  });

  // 评论图片早就有 @MaxLength(500, { each })；动态本体的图片数组此前只限了张数，
  // 单个元素可以是任意长的字符串。存储签发的 URL 远短于 500。
  it('rejects an image URL longer than 500 characters', () => {
    const dto = plainToInstance(CreateTraceDto, {
      content: 'hello',
      images: [`https://cdn.example.com/${'a'.repeat(500)}.jpg`],
    });

    const target = validateSync(dto).find(
      (error) => error.property === 'images',
    );
    expect(target?.constraints).toHaveProperty('maxLength');
  });

  // APP 每张图单独 presign（对象 key 带 randomUUID），不会发出重复 URL；重复只可能来自
  // 构造的请求，照收会让同一张图在动态里出现多次。
  it('rejects duplicate image URLs', () => {
    const dto = plainToInstance(CreateTraceDto, {
      content: 'hello',
      images: [storageUrl(1), storageUrl(1)],
    });

    const target = validateSync(dto).find(
      (error) => error.property === 'images',
    );
    expect(target?.constraints).toHaveProperty('arrayUnique');
  });
});
