import { MallService } from './mall.service';

describe('MallService', () => {
  it('returns mall sections with group expansion, fancy number, membership and points products', () => {
    const service = new MallService();

    const sections = service.getSections();
    const serialized = JSON.stringify(sections);

    expect(serialized).toContain('群扩容卡');
    expect(serialized).toContain('靓号');
    expect(serialized).toContain('会员充值');
    expect(serialized).toContain('积分充值');
    expect(serialized).not.toContain('帮积分');
  });
});
