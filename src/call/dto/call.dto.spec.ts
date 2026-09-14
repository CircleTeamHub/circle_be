import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateDirectCallDto,
  CreateGroupCallDto,
  LeaveCallDto,
} from './call.dto';

const USER_A = '2f7c1d9e-8b3a-4c5d-9e1f-0a1b2c3d4e5f';
const USER_B = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function errorsFor(
  cls: new () => object,
  body: Record<string, unknown>,
): string[] {
  return validateSync(plainToInstance(cls, body)).map(
    (error) => error.property,
  );
}

describe('LeaveCallDto', () => {
  // reason 的类型标注就是可选的,服务端也从不读它;缺了 @IsOptional 时,
  // 一个空 body 会被 @IsString 拒成 400,通话根本挂不断。
  it('accepts an empty body', () => {
    expect(validateSync(plainToInstance(LeaveCallDto, {}))).toHaveLength(0);
  });

  it('keeps accepting the mobile client shape', () => {
    expect(
      validateSync(plainToInstance(LeaveCallDto, { reason: 'NORMAL' })),
    ).toHaveLength(0);
  });

  it('rejects an oversized reason', () => {
    const errors = validateSync(
      plainToInstance(LeaveCallDto, { reason: 'a'.repeat(33) }),
    );
    expect(errors.some((error) => error.property === 'reason')).toBe(true);
  });
});

describe('CreateGroupCallDto', () => {
  const valid = {
    conversationID: USER_A,
    callType: 'AUDIO',
    inviteeIDs: [USER_B],
  };

  it('accepts the shape the app sends', () => {
    expect(errorsFor(CreateGroupCallDto, valid)).toEqual([]);
  });

  // App 传的是自研聊天会话 id(uuid);服务端还认 Circle.id 与 sg_ 前缀 / 旧 OpenIM
  // 形态的 Circle.groupID(groupIDCandidates)—— 所以不能收成 @IsUUID,只限长度与字符集。
  it.each([
    ['a chat conversation uuid', USER_A],
    ['the legacy sg_-prefixed group id', `sg_${USER_A}`],
    ['a legacy OpenIM-era group id', 'group-1_legacy'],
  ])('accepts %s as conversationID', (_case, conversationID) => {
    expect(errorsFor(CreateGroupCallDto, { ...valid, conversationID })).toEqual(
      [],
    );
  });

  it.each([
    ['an oversized id', 'a'.repeat(65)],
    ['whitespace', 'group 1'],
    ['path traversal', '../group-1'],
    ['markup', '<script>'],
    ['an empty string', ''],
  ])('rejects %s as conversationID', (_case, conversationID) => {
    expect(
      errorsFor(CreateGroupCallDto, { ...valid, conversationID }),
    ).toContain('conversationID');
  });

  // 邀请名单最终要逐个命中 ACTIVE 的 User.id(loadActiveUsers),通话服务不做别名
  // 归一 —— 能成功的只有 uuid。
  it.each([
    ['a temp-room guest id', 'g0123456789abcdef0123456789abcdef'],
    ['a 32-hex alias', USER_B.replace(/-/g, '')],
  ])('rejects %s among inviteeIDs', (_case, invitee) => {
    expect(
      errorsFor(CreateGroupCallDto, {
        ...valid,
        inviteeIDs: [USER_B, invitee],
      }),
    ).toContain('inviteeIDs');
  });
});

describe('CreateDirectCallDto', () => {
  it('accepts a user uuid as calleeID', () => {
    expect(
      errorsFor(CreateDirectCallDto, { calleeID: USER_B, callType: 'VIDEO' }),
    ).toEqual([]);
  });

  it.each([
    [
      'a 32-hex alias the call service never normalizes',
      USER_B.replace(/-/g, ''),
    ],
    ['an arbitrary string', 'user-2'],
  ])('rejects %s', (_case, calleeID) => {
    expect(
      errorsFor(CreateDirectCallDto, { calleeID, callType: 'AUDIO' }),
    ).toContain('calleeID');
  });
});
