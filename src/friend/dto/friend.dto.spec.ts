import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SendFriendRequestDto } from './friend.dto';

describe('SendFriendRequestDto', () => {
  it('rejects oversized request messages', () => {
    const dto = plainToInstance(SendFriendRequestDto, {
      targetId: '550e8400-e29b-41d4-a716-446655440000',
      message: 'a'.repeat(201),
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'message')).toBe(true);
  });
});
