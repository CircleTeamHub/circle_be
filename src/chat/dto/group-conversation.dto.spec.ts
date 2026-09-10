import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateGroupConversationDto } from './group-conversation.dto';

async function parse(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateGroupConversationDto, input, {
    enableImplicitConversion: true,
  });
  return { dto, errors: await validate(dto) };
}

describe('CreateGroupConversationDto', () => {
  it('requires a non-blank group name and trims a valid name', async () => {
    const memberIds = ['openim-tomcoming', 'legacy-user-tui'];
    expect((await parse({ memberIds })).errors.length).toBeGreaterThan(0);
    expect(
      (await parse({ name: '   ', memberIds })).errors.length,
    ).toBeGreaterThan(0);

    const { dto, errors } = await parse({
      name: '  周末爬山  ',
      memberIds,
    });
    expect(errors).toHaveLength(0);
    expect(dto.name).toBe('周末爬山');
  });

  it('accepts non-UUID legacy user IDs and trims surrounding whitespace', async () => {
    const { dto, errors } = await parse({
      name: '周末爬山',
      memberIds: ['  openim-tomcoming  ', 'legacy-user-tui'],
    });

    expect(errors).toHaveLength(0);
    expect(dto.memberIds).toEqual(['openim-tomcoming', 'legacy-user-tui']);
  });

  it('rejects blank member IDs', async () => {
    const { errors } = await parse({
      name: '周末爬山',
      memberIds: ['openim-tomcoming', '   '],
    });

    expect(errors).not.toHaveLength(0);
  });
});
