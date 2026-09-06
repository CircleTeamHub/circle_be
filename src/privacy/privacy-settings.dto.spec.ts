import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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
