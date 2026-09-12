import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  SetGroupMuteAllDto,
  UpdateGroupPoliciesDto,
} from './group-settings.dto';

const transformOptions = { enableImplicitConversion: true };

describe('group settings boolean DTOs', () => {
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
