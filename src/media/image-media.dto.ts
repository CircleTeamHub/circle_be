import { ApiProperty } from '@nestjs/swagger';
import type { ImageMediaVariant } from './image-media';

export class ImageMediaVariantDto implements ImageMediaVariant {
  @ApiProperty() thumb: string;
  @ApiProperty() preview: string;
  @ApiProperty() original: string;
}
