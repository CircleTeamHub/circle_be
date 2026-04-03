import { AppFactory } from './app.factory';
import { INestApplication } from '@nestjs/common';
import * as pactum from 'pactum';

let appFactory: AppFactory;
let app: INestApplication;

global.beforeEach(async () => {
  appFactory = await AppFactory.init();
  await appFactory.initDB();
  app = appFactory.instance;

  pactum.request.setBaseUrl(await app.getUrl());
  global.pactum = pactum;
  global.spec = pactum.spec();
});

global.afterEach(async () => {
  await appFactory?.destory();
});
