import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  DisplayIconTypeDto,
  SystemIconKeyDto,
  UpdateDisplayIconItemDto,
} from './icon.dto';

// PARTNER 徽章早已下线:IconService.buildEligibility 从不产出它,选中它必然被业务层
// 拒掉;circle-im 的契约测试也钉死端上不再出现 PARTNER。Prisma 枚举为兼容已经跑过
// 旧迁移的库仍保留该值,但请求契约里不再接受。
describe('SystemIconKeyDto', () => {
  it('does not offer the retired PARTNER badge', () => {
    expect(Object.values(SystemIconKeyDto)).not.toContain('PARTNER');
  });

  it('rejects PARTNER as a display-icon systemKey at validation time', () => {
    const dto = plainToInstance(UpdateDisplayIconItemDto, {
      displayType: DisplayIconTypeDto.SYSTEM,
      systemKey: 'PARTNER',
      systemVariant: 'PARTNER',
      sortOrder: 0,
    });

    expect(
      validateSync(dto).some((error) => error.property === 'systemKey'),
    ).toBe(true);
  });
});
