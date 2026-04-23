import { Injectable } from '@nestjs/common';
import { MallSectionDto } from './dto/mall.dto';

const MALL_SECTIONS: MallSectionDto[] = [
  {
    id: 'cards',
    title: '我的卡券',
    products: [
      {
        id: 'fancy-number-card',
        name: '靓号卡',
        icon: 'sparkles-outline',
        color: '#2563EB',
        action: 'fancy-number',
      },
      {
        id: 'group-expansion-card',
        name: '群扩容卡',
        icon: 'people-outline',
        color: '#E11D48',
        action: 'group-expansion',
      },
      {
        id: 'generate-recharge-card',
        name: '生成充值卡',
        icon: 'card-outline',
        color: '#2563EB',
        action: 'recharge-card-create',
      },
      {
        id: 'my-recharge-cards',
        name: '我的充值卡',
        icon: 'receipt-outline',
        color: '#2563EB',
        action: 'recharge-card-list',
      },
    ],
  },
  {
    id: 'membership',
    title: '会员专区',
    products: [
      {
        id: 'membership-upgrade',
        name: '会员充值',
        icon: 'diamond-outline',
        color: '#F59E0B',
        action: 'membership',
      },
      {
        id: 'experience-exchange',
        name: '兑换经验',
        icon: 'trending-up-outline',
        color: '#F59E0B',
        action: 'experience',
      },
      {
        id: 'points-recharge',
        name: '积分充值',
        icon: 'wallet-outline',
        color: '#F59E0B',
        action: 'wallet',
      },
    ],
  },
  {
    id: 'fancy-number',
    title: '靓号专区',
    products: [
      {
        id: 'choose-fancy-number',
        name: '自选靓号',
        icon: 'ribbon-outline',
        color: '#E11D48',
        action: 'fancy-number',
      },
      {
        id: 'renew-fancy-number',
        name: '续费靓号',
        icon: 'bookmark-outline',
        color: '#E11D48',
        action: 'fancy-number-renew',
      },
    ],
  },
  {
    id: 'points',
    title: '积分专区',
    products: [
      {
        id: 'redeem-code',
        name: '查询&兑换卡密',
        icon: 'server-outline',
        color: '#2563EB',
        action: 'redeem-code',
      },
      {
        id: 'buy-code',
        name: '购买卡密',
        icon: 'bag-handle-outline',
        color: '#2563EB',
        action: 'buy-code',
      },
    ],
  },
  {
    id: 'decoration',
    title: '装扮专区',
    products: [
      {
        id: 'avatar-frame',
        name: '头像框',
        icon: 'image-outline',
        color: '#94A3B8',
        action: 'avatar-frame',
      },
    ],
  },
];

@Injectable()
export class MallService {
  getSections(): MallSectionDto[] {
    return MALL_SECTIONS;
  }
}
