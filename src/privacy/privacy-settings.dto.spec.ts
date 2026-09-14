import { plainToInstance } from 'class-transformer';
import { validate, validateSync } from 'class-validator';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AUTO_REPLY_TEXT_MAX_CODE_POINTS,
  UpdatePrivacySettingsDto,
} from './privacy-settings.dto';

async function errorsFor(input: Record<string, unknown>) {
  return validate(plainToInstance(UpdatePrivacySettingsDto, input));
}

describe('UpdatePrivacySettingsDto auto reply text', () => {
  // DTO 此前用 @MaxLength 数 UTF-16 码元，而 service 用 Array.from(...).length、
  // 数据库列是 VARCHAR(200)，后两者数的是码点。于是 120 个 emoji（240 码元、
  // 120 码点）会被 DTO 挡在门外，尽管另外两层都认为合法。三层必须同一把尺子。
  it('measures the limit in code points, not UTF-16 units', async () => {
    const emoji = '😀'.repeat(120);
    expect(emoji.length).toBeGreaterThan(AUTO_REPLY_TEXT_MAX_CODE_POINTS);
    expect(Array.from(emoji).length).toBeLessThanOrEqual(
      AUTO_REPLY_TEXT_MAX_CODE_POINTS,
    );

    expect(await errorsFor({ directMessageAutoReplyText: emoji })).toHaveLength(
      0,
    );
  });

  it('accepts exactly the limit and rejects one code point more', async () => {
    const atLimit = 'a'.repeat(AUTO_REPLY_TEXT_MAX_CODE_POINTS);
    expect(
      await errorsFor({ directMessageAutoReplyText: atLimit }),
    ).toHaveLength(0);

    const overLimit = 'a'.repeat(AUTO_REPLY_TEXT_MAX_CODE_POINTS + 1);
    expect(
      (await errorsFor({ directMessageAutoReplyText: overLimit })).length,
    ).toBeGreaterThan(0);
  });

  it('rejects a non-string body', async () => {
    expect(
      (await errorsFor({ directMessageAutoReplyText: 42 })).length,
    ).toBeGreaterThan(0);
  });
});

// UserPrivacySetting 的每一列都是非空列（prisma/schema.prisma）。@IsOptional 让显式的
// null 跳过校验：有 service 二次校验的几项回 400，其余布尔项直接落到 upsert →
// PrismaClientValidationError → 500。
describe('UpdatePrivacySettingsDto null handling', () => {
  const NON_NULLABLE = [
    'messageSelfDestructSec',
    'momentsVisibility',
    'allowStrangerMessages',
    'showPhone',
    'showEmail',
    'showWechat',
    'showQQ',
    'showWhatsup',
    'addMeByAccount',
    'addMeByPhone',
    'addMeByQrCode',
    'addMeByGroup',
    'callPermission',
    'groupInvitePermission',
    'directMessageAutoReplyEnabled',
    'directMessageAutoReplyText',
    'shareOnlineStatus',
    'shareTypingInDirect',
    'shareTypingInGroup',
  ];

  // 与全局 ValidationPipe 同一组选项（src/setup.ts）：隐式转换对 null 原样放行。
  function validateLikePipe(payload: Record<string, unknown>) {
    return validateSync(
      plainToInstance(UpdatePrivacySettingsDto, payload, {
        enableImplicitConversion: true,
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
  }

  it.each(NON_NULLABLE)('rejects an explicit null %s', (property) => {
    const target = validateLikePipe({ [property]: null }).find(
      (error) => error.property === property,
    );
    expect(target?.constraints).toHaveProperty('isDefined');
  });

  it('lists every property UpdatePrivacySettingsDto declares', () => {
    // 新增设置项时这条会红：它要么是非空列（进上面的清单、用 @IsOptionalNotNull），
    // 要么在这里写明为什么 null 有意义。
    const source = readFileSync(
      join(process.cwd(), 'src/privacy/privacy-settings.dto.ts'),
      'utf8',
    );
    const updateDto = source.slice(
      source.indexOf('export class UpdatePrivacySettingsDto'),
    );
    const declared = [...updateDto.matchAll(/^ {2}(\w+)\?:/gm)].map(
      (match) => match[1],
    );
    expect(new Set(declared)).toEqual(new Set(NON_NULLABLE));
  });

  it('still accepts omitted fields and ordinary values', () => {
    expect(validateLikePipe({})).toHaveLength(0);
    expect(
      validateLikePipe({
        showPhone: true,
        momentsVisibility: 'FRIENDS_ONLY',
        callPermission: 'NONE',
        directMessageAutoReplyEnabled: false,
        directMessageAutoReplyText: '',
      }),
    ).toHaveLength(0);
  });
});
