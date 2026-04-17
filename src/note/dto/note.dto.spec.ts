import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateNoteDto, ReorderNoteGroupsDto } from './note.dto';

describe('CreateNoteDto', () => {
  it('rejects duplicated media sort orders', () => {
    const dto = plainToInstance(CreateNoteDto, {
      title: '测试笔记',
      media: [
        {
          type: 'IMAGE',
          objectKey: 'notes/user-1/1.jpg',
          url: 'https://cdn.example.com/1.jpg',
          sortOrder: 0,
        },
        {
          type: 'VIDEO',
          objectKey: 'notes/user-1/1.mp4',
          url: 'https://cdn.example.com/1.mp4',
          sortOrder: 0,
        },
      ],
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'media')).toBe(true);
  });

  it('rejects oversized note titles', () => {
    const dto = plainToInstance(CreateNoteDto, {
      title: 'a'.repeat(121),
      media: [],
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'title')).toBe(true);
  });

  it('rejects DELETED as a writable status', () => {
    const dto = plainToInstance(CreateNoteDto, {
      title: '测试笔记',
      status: 'DELETED',
      media: [],
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });

  it('accepts block contentJson arrays', () => {
    const dto = plainToInstance(CreateNoteDto, {
      title: '测试笔记',
      contentJson: [
        {
          id: 'block-1',
          type: 'heading',
          content: [{ type: 'text', text: '标题' }],
        },
        {
          id: 'block-2',
          type: 'paragraph',
          content: [{ type: 'text', text: '正文' }],
        },
      ],
      media: [],
    });

    const errors = validateSync(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects an empty title', () => {
    const dto = plainToInstance(CreateNoteDto, {
      title: '',
      media: [],
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'title')).toBe(true);
  });

  it('accepts multiple group ids and rejects invalid group id payloads', () => {
    const validDto = plainToInstance(CreateNoteDto, {
      title: '测试笔记',
      groupIds: [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ],
      media: [],
    });

    expect(validateSync(validDto)).toHaveLength(0);

    const invalidDto = plainToInstance(CreateNoteDto, {
      title: '测试笔记',
      groupIds: ['not-a-uuid'],
      media: [],
    });

    expect(
      validateSync(invalidDto).some((error) => error.property === 'groupIds'),
    ).toBe(true);
  });
});

describe('ReorderNoteGroupsDto', () => {
  it('accepts a group id list and rejects non-uuid ids', () => {
    const validDto = plainToInstance(ReorderNoteGroupsDto, {
      groupIds: [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ],
    });

    expect(validateSync(validDto)).toHaveLength(0);

    const invalidDto = plainToInstance(ReorderNoteGroupsDto, {
      groupIds: ['group-1'],
    });

    expect(
      validateSync(invalidDto).some((error) => error.property === 'groupIds'),
    ).toBe(true);
  });
});
