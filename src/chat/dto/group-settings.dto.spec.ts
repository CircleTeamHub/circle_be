import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  RequestHistoryClearDto,
  RespondHistoryClearDto,
  SetGroupMuteAllDto,
  SetGroupNoticeDto,
  UpdateGroupPoliciesDto,
} from './group-settings.dto';

const transformOptions = { enableImplicitConversion: true };

describe('group settings boolean DTOs', () => {
  it.each(['false', 'true', 0, 1, null])(
    'rejects invalid notice broadcast flag %p',
    (value) => {
      const dto = plainToInstance(
        SetGroupNoticeDto,
        { notice: '公告', noticePinned: value },
        transformOptions,
      );
      expect(
        validateSync(dto).some((error) => error.property === 'noticePinned'),
      ).toBe(true);
    },
  );

  it.each([true, false, undefined])(
    'accepts the optional notice broadcast flag %p',
    (value) => {
      expect(
        validateSync(
          plainToInstance(
            SetGroupNoticeDto,
            { notice: '公告', noticePinned: value },
            transformOptions,
          ),
        ),
      ).toHaveLength(0);
    },
  );
  it('rejects a string false for the mute-all switch', () => {
    const dto = plainToInstance(
      SetGroupMuteAllDto,
      { enabled: 'false' },
      transformOptions,
    );

    expect(validateSync(dto).map((error) => error.property)).toContain(
      'enabled',
    );
  });

  it('rejects string booleans for every group policy switch', () => {
    const dto = plainToInstance(
      UpdateGroupPoliciesDto,
      {
        memberCanInvite: 'false',
        qrJoinEnabled: 'false',
        membersCanViewRoster: 'false',
        membersCanViewProfiles: 'false',
        membersCanAddFriends: 'false',
      },
      transformOptions,
    );

    expect(new Set(validateSync(dto).map((error) => error.property))).toEqual(
      new Set([
        'memberCanInvite',
        'membersCanAddFriends',
        'membersCanViewProfiles',
        'membersCanViewRoster',
        'qrJoinEnabled',
      ]),
    );
  });

  it('still accepts real booleans and omitted optional policies', () => {
    const muteAll = plainToInstance(
      SetGroupMuteAllDto,
      { enabled: false },
      transformOptions,
    );
    const policies = plainToInstance(
      UpdateGroupPoliciesDto,
      { membersCanAddFriends: false },
      transformOptions,
    );

    expect(validateSync(muteAll)).toHaveLength(0);
    expect(validateSync(policies)).toHaveLength(0);
  });
});

// 双向清空:全局 enableImplicitConversion 会把 "false" 转成 true —— 那是一次
// 不可逆的「同意」;false→0 会让申请悄悄变成「清到 0」。
describe('two-way clear DTOs', () => {
  it.each(['false', '0', 'no', 1, null])(
    'rejects a non-boolean accept %p',
    (value) => {
      const dto = plainToInstance(
        RespondHistoryClearDto,
        { accept: value },
        transformOptions,
      );
      expect(validateSync(dto).some((e) => e.property === 'accept')).toBe(true);
    },
  );

  it.each([false, true, '3', null])(
    'rejects a non-integer target height %p',
    (value) => {
      const dto = plainToInstance(
        RequestHistoryClearDto,
        { targetHeight: value },
        transformOptions,
      );
      expect(validateSync(dto).some((e) => e.property === 'targetHeight')).toBe(
        true,
      );
    },
  );

  it('accepts the real shapes', () => {
    const respond = plainToInstance(
      RespondHistoryClearDto,
      { accept: false },
      transformOptions,
    );
    const request = plainToInstance(
      RequestHistoryClearDto,
      { targetHeight: 42 },
      transformOptions,
    );
    expect(validateSync(respond)).toHaveLength(0);
    expect(respond.accept).toBe(false);
    expect(validateSync(request)).toHaveLength(0);
    expect(request.targetHeight).toBe(42);
  });
});
