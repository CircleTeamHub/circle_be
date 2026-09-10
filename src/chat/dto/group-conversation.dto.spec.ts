import 'reflect-metadata';
import { type ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateGroupConversationDto,
  InviteGroupMembersDto,
} from './group-conversation.dto';

async function parse(input: Record<string, unknown>) {
  const dto = plainToInstance(CreateGroupConversationDto, input, {
    enableImplicitConversion: true,
  });
  return { dto, errors: await validate(dto) };
}

const createGroupBody: ArgumentMetadata = {
  type: 'body',
  metatype: CreateGroupConversationDto,
  data: '',
};

function createProductionValidationPipe() {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
}

describe('CreateGroupConversationDto', () => {
  it('trims a valid group name while allowing the service to return the required-name error', async () => {
    const memberIds = ['openim-tomcoming', 'legacy-user-tui'];
    expect((await parse({ memberIds })).errors).toHaveLength(0);
    expect((await parse({ name: '   ', memberIds })).errors).toHaveLength(0);

    const { dto, errors } = await parse({
      name: '  周末爬山  ',
      memberIds,
    });
    expect(errors).toHaveLength(0);
    expect(dto.name).toBe('周末爬山');
  });

  it('passes a missing or blank name to the service for the stable required-name error', async () => {
    const pipe = createProductionValidationPipe();
    const memberIds = ['openim-tomcoming', 'legacy-user-tui'];

    await expect(
      pipe.transform({ memberIds }, createGroupBody),
    ).resolves.toMatchObject({ memberIds });
    await expect(
      pipe.transform({ name: '   ', memberIds }, createGroupBody),
    ).resolves.toMatchObject({ name: '', memberIds });
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

  it('accepts trimmed legacy user IDs for invitations and rejects blank IDs', async () => {
    const accepted = plainToInstance(
      InviteGroupMembersDto,
      { memberIds: ['  openim-tomcoming  ', 'legacy-user-tui'] },
      { enableImplicitConversion: true },
    );
    expect(await validate(accepted)).toHaveLength(0);
    expect(accepted.memberIds).toEqual(['openim-tomcoming', 'legacy-user-tui']);

    const rejected = plainToInstance(
      InviteGroupMembersDto,
      { memberIds: ['openim-tomcoming', '   '] },
      { enableImplicitConversion: true },
    );
    expect(await validate(rejected)).not.toHaveLength(0);
  });
});
