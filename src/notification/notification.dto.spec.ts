import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MAX_PAGE } from 'src/common/pagination';
import {
  EditSystemAnnouncementDto,
  AnnouncementScrollingDto,
  PublishSystemAnnouncementDto,
  mapNotificationRealtimeDto,
  NotificationListQueryDto,
  NotificationPageQueryDto,
  RegisterPushTokenDto,
  RevokePushTokenDto,
  UpdateCirclePushPreferenceDto,
} from './notification.dto';

describe('push token DTOs', () => {
  const registration = (overrides: Record<string, unknown> = {}) =>
    plainToInstance(RegisterPushTokenDto, {
      token: 'ExponentPushToken[abc]',
      platform: 'ios',
      provider: 'expo',
      ...overrides,
    });

  it('keeps revocation secrets optional for legacy registration clients', () => {
    expect(validateSync(registration())).toHaveLength(0);
  });

  it('accepts registration revocation secrets from 32 through 256 characters', () => {
    expect(
      validateSync(registration({ revocationSecret: 'a'.repeat(32) })),
    ).toHaveLength(0);
    expect(
      validateSync(registration({ revocationSecret: 'b'.repeat(256) })),
    ).toHaveLength(0);
  });

  it('rejects registration revocation secrets outside the length bounds', () => {
    for (const revocationSecret of ['a'.repeat(31), 'b'.repeat(257)]) {
      expect(
        validateSync(registration({ revocationSecret })).map(
          (error) => error.property,
        ),
      ).toContain('revocationSecret');
    }
  });

  it('requires a bounded token and revocation secret for public revocation', () => {
    const valid = plainToInstance(RevokePushTokenDto, {
      token: 'ExponentPushToken[abc]',
      revocationSecret: 's'.repeat(32),
    });
    expect(validateSync(valid)).toHaveLength(0);

    const missing = plainToInstance(RevokePushTokenDto, {});
    expect(
      validateSync(missing)
        .map((error) => error.property)
        .sort(),
    ).toEqual(['revocationSecret', 'token']);

    const invalid = plainToInstance(RevokePushTokenDto, {
      token: 't'.repeat(513),
      revocationSecret: 's'.repeat(31),
    });
    expect(
      validateSync(invalid)
        .map((error) => error.property)
        .sort(),
    ).toEqual(['revocationSecret', 'token']);
  });
});

describe('push token shape validation (#98)', () => {
  const registration = (token: string) =>
    plainToInstance(RegisterPushTokenDto, {
      token,
      platform: 'ios' as const,
      provider: 'expo' as const,
    });

  it('accepts both Expo push token spellings', () => {
    expect(
      validateSync(registration('ExponentPushToken[abc-DEF_123]')),
    ).toHaveLength(0);
    expect(validateSync(registration('ExpoPushToken[abc]'))).toHaveLength(0);
  });

  it('rejects junk that is not an Expo push token', () => {
    for (const junk of [
      'not-a-token',
      'ExponentPushToken[]',
      'ExponentPushToken[with space]',
      'fcm:abcdef',
      'ExponentPushToken[abc', // 未闭合
    ]) {
      expect(validateSync(registration(junk)).map((e) => e.property)).toContain(
        'token',
      );
    }
  });

  it('accepts a non-whitespace JPush registration ID', () => {
    expect(
      validateSync(
        plainToInstance(RegisterPushTokenDto, {
          token: '190e35e4f7b94e5fa2c6',
          platform: 'ios',
          provider: 'jpush',
        }),
      ),
    ).toHaveLength(0);
  });
});

describe('UpdateCirclePushPreferenceDto', () => {
  // 全局 ValidationPipe 开着 enableImplicitConversion（src/setup.ts），它跑在
  // 校验之前，会把任意非空字符串转成 true。plainToInstance 带上同一个选项，
  // 测的才是线上那条路径。
  const parse = (value: unknown) =>
    plainToInstance(
      UpdateCirclePushPreferenceDto,
      { circleOfflinePushEnabled: value },
      { enableImplicitConversion: true },
    );

  it('接受真正的布尔值', () => {
    for (const value of [true, false]) {
      const dto = parse(value);
      expect(validateSync(dto)).toHaveLength(0);
      expect(dto.circleOfflinePushEnabled).toBe(value);
    }
  });

  // 这才是这个开关最要命的输入：`"false"` 被隐式转换成 true，用户以为关掉了
  // 离线提醒、服务端照推不误 —— 而关掉它正是这个接口存在的唯一理由。
  it('拒绝会被隐式转换成 true 的字符串', () => {
    for (const value of ['false', '0', 'true', '1', 'no']) {
      expect(
        validateSync(parse(value)).map((error) => error.property),
      ).toContain('circleOfflinePushEnabled');
    }
  });

  it('拒绝数字、null 与缺字段', () => {
    for (const value of [0, 1, null, undefined]) {
      expect(
        validateSync(parse(value)).map((error) => error.property),
      ).toContain('circleOfflinePushEnabled');
    }
    expect(
      validateSync(
        plainToInstance(
          UpdateCirclePushPreferenceDto,
          {},
          { enableImplicitConversion: true },
        ),
      ).map((error) => error.property),
    ).toContain('circleOfflinePushEnabled');
  });
});

describe('notification page bound', () => {
  // OFFSET 的代价随页码线性增长（src/common/pagination.ts）。app 每页 20 条、只会
  // 逐页加载系统通知：500 页 = 1 万条，远超 90 天保留期内的真实量。
  const errorsFor = (
    Dto: typeof NotificationPageQueryDto | typeof NotificationListQueryDto,
    page: string,
  ) =>
    validateSync(
      plainToInstance(Dto, { page }, { enableImplicitConversion: true }),
    ).map((error) => error.property);

  it('accepts MAX_PAGE and rejects MAX_PAGE + 1 on both list query DTOs', () => {
    for (const Dto of [NotificationPageQueryDto, NotificationListQueryDto]) {
      expect(errorsFor(Dto, String(MAX_PAGE))).toEqual([]);
      expect(errorsFor(Dto, String(MAX_PAGE + 1))).toEqual(['page']);
    }
  });

  it('accepts a bounded cursor and rejects an oversized cursor', () => {
    expect(
      validateSync(
        plainToInstance(NotificationPageQueryDto, { cursor: 'cursor' }),
      ),
    ).toHaveLength(0);
    expect(
      validateSync(
        plainToInstance(NotificationListQueryDto, {
          cursor: 'c'.repeat(257),
        }),
      )
        .map((error) => error.property)
        .sort(),
    ).toEqual(['cursor']);
  });

  it('accepts explicit cursor mode booleans and rejects other values', () => {
    for (const value of ['true', 'false']) {
      expect(
        validateSync(
          plainToInstance(
            NotificationPageQueryDto,
            { cursorMode: value },
            { enableImplicitConversion: true },
          ),
        ),
      ).toHaveLength(0);
    }
    expect(
      validateSync(
        plainToInstance(
          NotificationPageQueryDto,
          { cursorMode: '1' },
          { enableImplicitConversion: true },
        ),
      )
        .map((error) => error.property)
        .sort(),
    ).toEqual(['cursorMode']);
  });
});


describe('announcement title', () => {
  it('trims and bounds titles while accepting legacy requests without titles', () => {
    const valid = plainToInstance(PublishSystemAnnouncementDto, { title: '  维护通知  ', content: '正文' });
    expect(validateSync(valid)).toHaveLength(0);
    expect(valid.title).toBe('维护通知');
    for (const title of ['', '   ', 'x'.repeat(101)]) {
      expect(validateSync(plainToInstance(PublishSystemAnnouncementDto, { title, content: '正文' })).map(e => e.property)).toContain('title');
    }
    expect(validateSync(plainToInstance(PublishSystemAnnouncementDto, {content:'旧客户端正文'}))).toHaveLength(0);
  });
  it('returns the announcement title with its notification body', () => {
    const dto = mapNotificationRealtimeDto({ id: 'n', type: 'SYSTEM', content: '公告正文', read: false, createdAt: new Date(), systemAnnouncement: { title: '公告标题' } } as any);
    expect(dto).toEqual(expect.objectContaining({title:'公告标题',content:'公告正文'}));
  });
});

it('requires a boolean scrolling setting and does not coerce strings',()=>{
  expect(validateSync(plainToInstance(AnnouncementScrollingDto,{scrolling:false}))).toHaveLength(0);
  for(const scrolling of ['false','true',null,undefined,1]) expect(validateSync(plainToInstance(AnnouncementScrollingDto,{scrolling}))).not.toHaveLength(0);
});

it('requires both title and body for announcement edits',()=>{
 for(const fields of [{content:'正文'},{title:'标题'},{title:' ',content:'正文'},{title:'标题',content:' '},{title:'x'.repeat(101),content:'正文'}]){
  expect(validateSync(plainToInstance(EditSystemAnnouncementDto,fields))).not.toHaveLength(0);
 }
 const dto=plainToInstance(EditSystemAnnouncementDto,{title:' 标题 ',content:' 正文 '});
 expect(validateSync(dto)).toHaveLength(0);expect(dto.title).toBe('标题');expect(dto.content).toBe('正文');
});
