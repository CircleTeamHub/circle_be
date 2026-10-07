import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { TraceDto, TraceCommentDto } from '../trace/dto/trace.dto';
import { PlazaPostDto } from '../circle-plaza/dto/circle-plaza.dto';

it('publishes all image variants on plaza, trace and comment response contracts', async () => {
  @Controller('media')
  class Probe {
    @Get('trace') @ApiOkResponse({ type: TraceDto }) trace() {}
    @Get('comment') @ApiOkResponse({ type: TraceCommentDto }) comment() {}
    @Get('plaza') @ApiOkResponse({ type: PlazaPostDto }) plaza() {}
  }
  const module = await Test.createTestingModule({
    controllers: [Probe],
  }).compile();
  const app = module.createNestApplication();
  try {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Test').setVersion('1').build(),
    );
    for (const name of ['TraceDto', 'TraceCommentDto', 'PlazaPostDto']) {
      expect(
        (doc.components!.schemas![name] as any).properties.media,
      ).toMatchObject({
        type: 'array',
        items: { $ref: '#/components/schemas/ImageMediaVariantDto' },
      });
    }
    const variant = doc.components!.schemas!.ImageMediaVariantDto as any;
    for (const prop of ['thumb', 'preview', 'original'])
      expect(variant.properties[prop]).toEqual({ type: 'string' });
  } finally {
    await app.close();
  }
});
