import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PresignDto } from './presign.dto';

describe('PresignDto', () => {
  const valid = {
    filename: 'avatar.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1024,
  };
  const filenameError = (filename: string) =>
    validateSync(plainToInstance(PresignDto, { ...valid, filename })).find(
      (error) => error.property === 'filename',
    );

  it('accepts a valid payload', () => {
    expect(validateSync(plainToInstance(PresignDto, valid))).toHaveLength(0);
  });

  // 与访客侧 GuestPresignDto 的 255 对齐：文件名只用来取扩展名，但没有上限时
  // 任意长的名字会原样往下传（日志 / 对象元数据），应在 DTO 层就拒掉。
  it('rejects a filename longer than 255 chars and accepts one at the cap', () => {
    expect(filenameError('a'.repeat(256))).toHaveProperty(
      'constraints.maxLength',
    );
    expect(filenameError('a'.repeat(255))).toBeUndefined();
  });
});
