import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateUserDto } from './update-user.dto';

describe('UpdateUserDto', () => {
  it('accepts local development asset URLs for avatar fields', () => {
    const dto = plainToInstance(UpdateUserDto, {
      avatarUrl: 'http://localhost:9000/circle/avatars/test.jpg',
      avatarFrame: 'http://localhost:9000/circle/frames/test.png',
      cover: 'http://localhost:9000/circle/covers/test.png',
    });

    const errors = validateSync(dto);

    expect(errors).toHaveLength(0);
  });
});
