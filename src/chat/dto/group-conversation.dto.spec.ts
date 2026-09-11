import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import {
  CreateGroupConversationDto,
  InviteGroupMembersDto,
} from './group-conversation.dto';

// 真实形态:User.id 是 @default(uuid()) 的标准 UUID;唯一合法的非 UUID 形态是
// 旧客户端缓存里去掉连字符的 32-hex 别名(src/user/user-id-alias.ts)。
const FRIEND_A = '2f7c1d9e-8b3a-4c5d-9e1f-0a1b2c3d4e5f';
const FRIEND_B = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const FRIEND_A_ALIAS = '2f7c1d9e8b3a4c5d9e1f0a1b2c3d4e5f';
const NAME = '周末爬山';

async function parse<T extends object>(
  cls: new () => T,
  input: Record<string, unknown>,
): Promise<{ dto: T; errors: ValidationError[] }> {
  const dto = plainToInstance(cls, input, { enableImplicitConversion: true });
  return { dto, errors: await validate(dto) };
}

const constraintsOf = (errors: ValidationError[], property: string) =>
  Object.keys(
    errors.find((error) => error.property === property)?.constraints ?? {},
  );

describe('CreateGroupConversationDto', () => {
  describe('name', () => {
    it('lets a missing or blank name through so the service can reject it with an error code', async () => {
      const missing = await parse(CreateGroupConversationDto, {
        memberIds: [FRIEND_A, FRIEND_B],
      });
      expect(missing.errors).toHaveLength(0);
      expect(missing.dto.name).toBeUndefined();

      const blank = await parse(CreateGroupConversationDto, {
        name: '   ',
        memberIds: [FRIEND_A, FRIEND_B],
      });
      expect(blank.errors).toHaveLength(0);
      expect(blank.dto.name).toBe('');

      // 旧契约的 name 是 `string | null`,老客户端仍可能发 null 上来。
      const explicitNull = await parse(CreateGroupConversationDto, {
        name: null,
        memberIds: [FRIEND_A, FRIEND_B],
      });
      expect(explicitNull.errors).toHaveLength(0);
      expect(explicitNull.dto.name).toBeUndefined();
    });

    it('trims a valid name', async () => {
      const { dto, errors } = await parse(CreateGroupConversationDto, {
        name: `  ${NAME}  `,
        memberIds: [FRIEND_A, FRIEND_B],
      });
      expect(errors).toHaveLength(0);
      expect(dto.name).toBe(NAME);
    });

    it('rejects a name longer than 30 characters', async () => {
      const { errors } = await parse(CreateGroupConversationDto, {
        name: 'x'.repeat(31),
        memberIds: [FRIEND_A, FRIEND_B],
      });
      expect(constraintsOf(errors, 'name')).toEqual(['maxLength']);
    });
  });

  describe('memberIds', () => {
    it('accepts UUIDs and 32-hex aliases and trims surrounding whitespace', async () => {
      const { dto, errors } = await parse(CreateGroupConversationDto, {
        name: NAME,
        memberIds: [`  ${FRIEND_A_ALIAS}  `, FRIEND_B],
      });
      expect(errors).toHaveLength(0);
      // 别名原样放行,归一成 UUID 是 ChatService 的事。
      expect(dto.memberIds).toEqual([FRIEND_A_ALIAS, FRIEND_B]);
    });

    it.each([
      ['a slug', 'openim-tomcoming'],
      ['a blank string', '   '],
      ['a truncated UUID', FRIEND_A.slice(0, 35)],
      ['a 31-hex alias', FRIEND_A_ALIAS.slice(0, 31)],
      ['a non-hex 32-char string', 'g'.repeat(32)],
    ])('rejects %s as a member id', async (_case, badId) => {
      const { errors } = await parse(CreateGroupConversationDto, {
        name: NAME,
        memberIds: [badId, FRIEND_B],
      });
      expect(constraintsOf(errors, 'memberIds')).toContain('matches');
    });

    it('rejects duplicate ids, including duplicates that only differ by whitespace', async () => {
      const { errors } = await parse(CreateGroupConversationDto, {
        name: NAME,
        memberIds: [FRIEND_A, ` ${FRIEND_A}`, FRIEND_B],
      });
      expect(constraintsOf(errors, 'memberIds')).toEqual(['arrayUnique']);
    });

    it('requires between 2 and 100 ids', async () => {
      const one = await parse(CreateGroupConversationDto, {
        name: NAME,
        memberIds: [FRIEND_A],
      });
      expect(constraintsOf(one.errors, 'memberIds')).toEqual(['arrayMinSize']);

      const tooMany = await parse(CreateGroupConversationDto, {
        name: NAME,
        memberIds: Array.from(
          { length: 101 },
          (_, index) =>
            `${index.toString(16).padStart(8, '0')}${'0'.repeat(24)}`,
        ),
      });
      expect(constraintsOf(tooMany.errors, 'memberIds')).toEqual([
        'arrayMaxSize',
      ]);
    });
  });
});

describe('InviteGroupMembersDto', () => {
  it('applies the same id rules with a minimum of one invitee', async () => {
    const alias = await parse(InviteGroupMembersDto, {
      memberIds: [FRIEND_A_ALIAS],
    });
    expect(alias.errors).toHaveLength(0);
    expect(alias.dto.memberIds).toEqual([FRIEND_A_ALIAS]);

    const slug = await parse(InviteGroupMembersDto, {
      memberIds: ['legacy-user-tui'],
    });
    expect(constraintsOf(slug.errors, 'memberIds')).toContain('matches');

    const duplicate = await parse(InviteGroupMembersDto, {
      memberIds: [FRIEND_A, FRIEND_A],
    });
    expect(constraintsOf(duplicate.errors, 'memberIds')).toEqual([
      'arrayUnique',
    ]);

    const empty = await parse(InviteGroupMembersDto, { memberIds: [] });
    expect(constraintsOf(empty.errors, 'memberIds')).toEqual(['arrayMinSize']);
  });
});
