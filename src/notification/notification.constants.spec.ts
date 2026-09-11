import { NotificationType } from 'src/generated/prisma';
import {
  CIRCLE_NOTIFICATION_TYPES,
  CIRCLE_OFFLINE_PUSH_TYPES,
  isCircleOfflinePushGated,
} from './notification.constants';

describe('圈子离线推送的门控面', () => {
  // 门控面曾经写成 `type.startsWith('CIRCLE_')`：它跟着枚举**名字**漂移，与铃铛
  // 白名单毫无关联，两张表分家时谁也不报警。这条断言是那道栓：铃铛认的每一种
  // 圈子通知，用户关掉「离线提醒」之后都必须真的关掉。
  it('圈子铃铛的每一种类型都在门控面里', () => {
    for (const type of CIRCLE_NOTIFICATION_TYPES) {
      expect(isCircleOfflinePushGated(type)).toBe(true);
    }
  });

  // 报名通知不进铃铛（未读走 CirclePostSignup.seenByAuthor），但它照样是一条
  // 把人吵醒的圈子推送 —— 门控面比铃铛面宽这一项，是刻意的。
  it('门控面 = 铃铛面 + 报名通知', () => {
    expect(new Set(CIRCLE_OFFLINE_PUSH_TYPES)).toEqual(
      new Set([
        ...CIRCLE_NOTIFICATION_TYPES,
        NotificationType.CIRCLE_POST_SIGNUP_CREATED,
      ]),
    );
  });

  // 枚举里新增 CIRCLE_* 类型时这条会红：是加进门控面，还是刻意留在门外，
  // 必须是一次显式决定，而不是靠名字前缀默认生效。
  it('枚举里的 CIRCLE_* 类型一个不漏地做过决定', () => {
    const circleTypes = Object.values(NotificationType).filter((type) =>
      type.startsWith('CIRCLE_'),
    );
    expect(new Set(CIRCLE_OFFLINE_PUSH_TYPES)).toEqual(new Set(circleTypes));
  });

  it('非圈子通知与空值一律不门控', () => {
    for (const type of [
      NotificationType.SYSTEM,
      NotificationType.TRACE_LIKE,
      NotificationType.FRIEND_REQUEST_RECEIVED,
      NotificationType.PROFILE_LIKE,
    ]) {
      expect(isCircleOfflinePushGated(type)).toBe(false);
    }
    expect(isCircleOfflinePushGated(null)).toBe(false);
    expect(isCircleOfflinePushGated(undefined)).toBe(false);
  });
});
