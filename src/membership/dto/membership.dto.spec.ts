import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import * as membershipDtos from './membership.dto';
import { CreateMembershipGrantDto } from './membership.dto';

describe('membership DTOs', () => {
  // UpgradeMembershipDto 是已删除的积分升级接口(POST /membership/upgrade)的请求体,
  // 只剩它自己的 spec 还在引用。会员升级只走审计化的管理员授予(CreateMembershipGrantDto)。
  it('no longer exports the retired points-upgrade body', () => {
    expect(
      (membershipDtos as unknown as Record<string, unknown>)
        .UpgradeMembershipDto,
    ).toBeUndefined();
  });

  // 原 UpgradeMembershipDto spec 钉的「VIP5 已下线」边界,在仍然存在的写入口上继续钉住。
  it('caps admin grants at the top supported tier (4 = super)', () => {
    const payload = {
      idempotencyKey: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    };
    const levelErrors = (targetLevel: number) =>
      validateSync(
        plainToInstance(CreateMembershipGrantDto, { ...payload, targetLevel }),
      ).filter((error) => error.property === 'targetLevel');

    expect(levelErrors(4)).toHaveLength(0);
    expect(levelErrors(5).length).toBeGreaterThan(0);
  });
});
