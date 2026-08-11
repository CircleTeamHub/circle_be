import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ReplaceSupportAgentsDto } from './support.dto';

// 与 src/setup.ts 的全局 ValidationPipe 同款设置。implicit conversion 是全局开启的,
// 单独给这个 DTO 关不掉,所以校验必须自己扛住字符串输入。
const PIPE_OPTIONS = {
  transformOptions: { enableImplicitConversion: true },
};

function validate(enabled: unknown) {
  const dto = plainToInstance(
    ReplaceSupportAgentsDto,
    {
      expectedRevision: 'deadbeef',
      agents: [
        {
          category: 'recharge',
          userID: '11111111-1111-4111-8111-111111111111',
          sortOrder: 0,
          enabled,
        },
      ],
    },
    PIPE_OPTIONS.transformOptions,
  );
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { value: dto.agents[0]?.enabled, errors };
}

describe('ReplaceSupportAgentsDto', () => {
  // 过渡期:旧管理台不会带这个字段,必填会让「新后端 + 旧管理台」窗口里每次保存都 400。
  it('accepts a body without expectedRevision during the rollout window', () => {
    const dto = plainToInstance(
      ReplaceSupportAgentsDto,
      {
        agents: [
          {
            category: 'recharge',
            userID: '11111111-1111-4111-8111-111111111111',
            sortOrder: 0,
            enabled: true,
          },
        ],
      },
      PIPE_OPTIONS.transformOptions,
    );
    expect(validateSync(dto)).toEqual([]);
    expect(dto.expectedRevision).toBeUndefined();
  });

  it('keeps real booleans intact', () => {
    expect(validate(true)).toMatchObject({ value: true, errors: [] });
    expect(validate(false)).toMatchObject({ value: false, errors: [] });
  });

  // enableImplicitConversion 会把任意非空字符串转成 true,于是 "false" 被静默地
  // 当成「启用」—— 管理员以为停用了某个客服,实际它还在线上接待。
  it.each(['false', 'true', '0', '1', ''])(
    'rejects the string %p instead of coercing it',
    (raw) => {
      const { errors } = validate(raw);
      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it('rejects numbers too', () => {
    expect(validate(0).errors.length).toBeGreaterThan(0);
    expect(validate(1).errors.length).toBeGreaterThan(0);
  });

  it('treats a missing enabled as absent rather than false', () => {
    const dto = plainToInstance(
      ReplaceSupportAgentsDto,
      {
        expectedRevision: 'deadbeef',
        agents: [
          {
            category: 'recharge',
            userID: '11111111-1111-4111-8111-111111111111',
            sortOrder: 0,
          },
        ],
      },
      PIPE_OPTIONS.transformOptions,
    );
    expect(validateSync(dto)).toEqual([]);
    expect(dto.agents[0].enabled).toBeUndefined();
  });
});
