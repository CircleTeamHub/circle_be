import { Injectable } from '@nestjs/common';
import { CreateMenuDto } from './dto/create-menu.dto';
import { UpdateMenuDto } from './dto/update-menu.dto';

// TODO: Re-implement with Prisma when menus/CASL are scoped in.
@Injectable()
export class MenusService {
  create(_createMenuDto: CreateMenuDto) {
    return null;
  }

  findAll() {
    return [];
  }

  findOne(_id: number) {
    return null;
  }

  update(_id: number, _updateMenuDto: UpdateMenuDto) {
    return null;
  }

  remove(_id: number) {
    return null;
  }
}
