import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  ReportFriendDto,
  SendFriendRequestDto,
  SetFriendPermissionDto,
} from './friend.dto';

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

describe('ReportFriendDto', () => {
  it('rejects oversized descriptions and too many evidence items', () => {
    const dto = plainToInstance(ReportFriendDto, {
      category: 'harassment',
      description: 'a'.repeat(501),
      evidence: ['1', '2', '3', '4', '5', '6'],
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'description')).toBe(true);
    expect(errors.some((error) => error.property === 'evidence')).toBe(true);
  });
});

describe('SetFriendPermissionDto', () => {
  it('accepts FULL and CHAT_ONLY and rejects unknown values', () => {
    expect(
      validateSync(
        plainToInstance(SetFriendPermissionDto, { permission: 'FULL' }),
      ),
    ).toHaveLength(0);
    expect(
      validateSync(
        plainToInstance(SetFriendPermissionDto, { permission: 'CHAT_ONLY' }),
      ),
    ).toHaveLength(0);
    expect(
      validateSync(
        plainToInstance(SetFriendPermissionDto, { permission: 'PRIVATE' }),
      ).some((error) => error.property === 'permission'),
    ).toBe(true);
  });
});
