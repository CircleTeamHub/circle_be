import { AppFactory } from './app.factory';
import { INestApplication } from '@nestjs/common';
import * as pactum from 'pactum';
import { clearE2eApp, setE2eApp } from './e2e-context';

let appFactory: AppFactory;
let app: INestApplication;

global.beforeEach(async () => {
  appFactory = await AppFactory.init();
  await appFactory.initDB();
  app = appFactory.instance;
  setE2eApp(app);

  pactum.request.setBaseUrl(await app.getUrl());
  global.pactum = pactum;
  global.spec = pactum.spec();
});

global.afterEach(async () => {
  try {
    await appFactory?.destory();
  } finally {
    clearE2eApp();
  }
});
