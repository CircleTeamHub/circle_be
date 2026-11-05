import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
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
