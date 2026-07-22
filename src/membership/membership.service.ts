import { Injectable } from '@nestjs/common';
import { MembershipPlanDto } from './dto/membership.dto';

const VIP_PLANS: MembershipPlanDto[] = [
  { level: 1, name: 'VIP1', price: 780, perks: '基础会员权益' },
  { level: 2, name: 'VIP2', price: 1280, perks: '更多群容量与基础折扣' },
  { level: 3, name: 'VIP3', price: 2100, perks: '高级身份标识与积分加成' },
  { level: 4, name: 'VIP4', price: 4600, perks: '专属靓号折扣与优先体验' },
];

@Injectable()
export class MembershipService {
  getPlans(): MembershipPlanDto[] {
    return VIP_PLANS;
  }
}
