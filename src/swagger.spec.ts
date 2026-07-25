import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { UserController } from './user/user.controller';

describe('POST /user/vip-levels OpenAPI response schema', () => {
  it('declares an object map of userId -> integer vipLevel', () => {
    // @ApiOkResponse 的元数据；不显式给 schema 时这里只有 description，客户端无法建模。
    const meta = Reflect.getMetadata(
      'swagger/apiResponse',
      UserController.prototype.getVipLevels,
    );
    const ok = meta?.['200'];
    expect(ok?.schema?.type).toBe('object');
    expect(ok?.schema?.additionalProperties).toEqual({ type: 'integer' });
  });
});

describe('Swagger setup', () => {
  it('creates a document builder config with bearer auth', () => {
    const config = new DocumentBuilder()
      .setTitle('NestJS Lesson API')
      .setDescription('API documentation for the NestJS lesson project')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    expect(config.info.title).toBe('NestJS Lesson API');
    expect(config.components?.securitySchemes).toHaveProperty('bearer');
    expect(typeof SwaggerModule.createDocument).toBe('function');
  });
});
