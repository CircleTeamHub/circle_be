import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DefaultAuthGuard } from './default-auth.guard';
import { JwtGuard } from './jwt.guard';
import { AnonymousAccess } from './anonymous-access.decorator';

const validate = jest.fn((payload: { sub: string }) => ({
  userId: payload.sub,
}));
@Injectable()
class TestStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: 'test-only-secret',
    });
  }
  validate(payload: { sub: string }) {
    return validate(payload);
  }
}
@Controller()
class TestController {
  @Get('new-route')
  protectedRoute(@Req() req: any) {
    return req.user;
  }
  @Get('explicit')
  @UseGuards(JwtGuard)
  explicit(@Req() req: any) {
    return req.user;
  }
  @Get('public')
  @AnonymousAccess('Test public endpoint')
  publicRoute() {
    return { ok: true };
  }
}

describe('HTTP authentication defaults', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: 'test-only-secret' });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [TestController],
      providers: [
        TestStrategy,
        { provide: APP_GUARD, useClass: DefaultAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => validate.mockClear());
  it('rejects a newly added route without credentials or with forged/expired credentials', async () => {
    await request(app.getHttpServer()).get('/new-route').expect(401);
    await request(app.getHttpServer())
      .get('/new-route')
      .auth('forged', { type: 'bearer' })
      .expect(401);
    await request(app.getHttpServer())
      .get('/new-route')
      .auth(jwt.sign({ sub: 'u1' }, { expiresIn: -1 }), { type: 'bearer' })
      .expect(401);
  });
  it('authenticates an otherwise unguarded route', async () => {
    const res = await request(app.getHttpServer())
      .get('/new-route')
      .auth(jwt.sign({ sub: 'u1' }), { type: 'bearer' })
      .expect(200);
    expect(res.body.userId).toBe('u1');
    expect(validate).toHaveBeenCalledTimes(1);
  });
  it('does not duplicate authentication on existing guarded routes', async () => {
    await request(app.getHttpServer())
      .get('/explicit')
      .auth(jwt.sign({ sub: 'u1' }), { type: 'bearer' })
      .expect(200);
    expect(validate).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer()).get('/explicit').expect(401);
  });
  it('keeps explicitly public handlers accessible', async () => {
    await request(app.getHttpServer()).get('/public').expect(200, { ok: true });
  });
});
