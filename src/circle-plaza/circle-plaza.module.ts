import { Module } from '@nestjs/common';
import { CirclePlazaController } from './circle-plaza.controller';
import { CirclePlazaService } from './circle-plaza.service';

@Module({
  controllers: [CirclePlazaController],
  providers: [CirclePlazaService],
})
export class CirclePlazaModule {}
