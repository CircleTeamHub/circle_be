import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserController } from './user/user.controller';

describe('trace & plaza author DTOs document vipLevel for OpenAPI', () => {
  const read = (p: string) =>
    readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

  it('decorates the author property and its vipLevel field so generated clients can model it', () => {
    // 无 nest swagger 编译插件时,响应 DTO 必须显式 @ApiProperty 才能出现在 OpenAPI 里。
    const trace = read('src/trace/dto/trace.dto.ts');
    expect(trace).toMatch(
      /@ApiProperty\(\{ type: TraceAuthorDto \}\)\s*\n\s*author: TraceAuthorDto;/,
    );
    const traceAuthor = trace.slice(
      trace.indexOf('export class TraceAuthorDto'),
    );
    expect(traceAuthor).toMatch(
      /@ApiProperty\(\{[\s\S]*?\}\)\s*\n\s*vipLevel: number \| null;/,
    );

    const plaza = read('src/circle-plaza/dto/circle-plaza.dto.ts');
    expect(plaza).toMatch(
      /@ApiProperty\(\{ type: PlazaPostAuthorDto \}\)\s*\n\s*author: PlazaPostAuthorDto;/,
    );
    const plazaAuthor = plaza.slice(
      plaza.indexOf('export class PlazaPostAuthorDto'),
    );
    expect(plazaAuthor).toMatch(
      /@ApiProperty\(\{[\s\S]*?\}\)\s*\n\s*vipLevel: number \| null;/,
    );
  });
});

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
