import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

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
