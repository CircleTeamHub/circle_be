import { ApiProperty } from '@nestjs/swagger';

export class MallProductDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() icon: string;
  @ApiProperty() color: string;
  @ApiProperty() action: string;
}

export class MallSectionDto {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty({ type: [MallProductDto] })
  products: MallProductDto[];
}
