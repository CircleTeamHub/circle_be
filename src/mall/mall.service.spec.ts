import { MallService } from './mall.service';

describe('MallService', () => {
  it('returns the mall without membership and points sections', () => {
    const service = new MallService();

    const sections = service.getSections();
    const serialized = JSON.stringify(sections);

    expect(sections.map((section) => section.id)).toEqual([
      'cards',
      'fancy-number',
      'decoration',
    ]);
    expect(serialized).toContain('群扩容卡');
    expect(serialized).toContain('靓号');
    expect(serialized).toContain('头像框');
    expect(serialized).not.toContain('会员专区');
    expect(serialized).not.toContain('积分专区');
  });
});
