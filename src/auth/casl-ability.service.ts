import { Injectable } from '@nestjs/common';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { Role } from 'src/enum/roles.enum';

// TODO: Re-implement with Prisma roles/menus graph when CASL is scoped in.
@Injectable()
export class CaslAbilityService {
  forRoot(role: string) {
    const { can, build } = new AbilityBuilder(createMongoAbility);
    if (role === Role.Admin) {
      can('manage', 'all');
    }
    return build();
  }
}
