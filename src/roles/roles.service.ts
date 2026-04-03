import { Injectable } from '@nestjs/common';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

// TODO: Re-implement with Prisma when group-chat roles are scoped in.
@Injectable()
export class RolesService {
  create(_createRoleDto: CreateRoleDto) {
    return null;
  }

  findAll() {
    return [];
  }

  findOne(_id: number) {
    return null;
  }

  update(_id: number, _updateRoleDto: UpdateRoleDto) {
    return null;
  }

  remove(_id: number) {
    return null;
  }
}
