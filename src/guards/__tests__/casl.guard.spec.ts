import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AnyMongoAbility } from '@casl/ability';
import { CaslAbilityService } from 'src/auth/casl-ability.service';
import { CHECK_POLICIES_KEY } from 'src/decorators/casl.decorator';
import { CaslGuard } from '../casl.guard';

function createContext(user?: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => jest.fn(),
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe('CaslGuard', () => {
  const ability = {
    can: jest.fn(),
    cannot: jest.fn(),
  } as unknown as AnyMongoAbility;
  const reflector = {
    getAllAndMerge: jest.fn(),
  } as unknown as Reflector;
  const caslAbilityService = {
    forRoot: jest.fn().mockResolvedValue(ability),
  } as unknown as CaslAbilityService;

  let guard: CaslGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new CaslGuard(reflector, caslAbilityService);
  });

  it('evaluates available policy metadata even when @Cannot is absent', async () => {
    (reflector.getAllAndMerge as jest.Mock).mockImplementation(
      (key: CHECK_POLICIES_KEY) => {
        if (key === CHECK_POLICIES_KEY.HANDLER) {
          return [() => true];
        }
        if (key === CHECK_POLICIES_KEY.CAN) {
          return [
            (currentAbility: AnyMongoAbility) =>
              currentAbility.can('read', 'logs'),
          ];
        }
        return undefined;
      },
    );
    (ability.can as jest.Mock).mockReturnValue(false);

    await expect(
      guard.canActivate(createContext({ role: 'USER' })),
    ).resolves.toBe(false);
  });
});
