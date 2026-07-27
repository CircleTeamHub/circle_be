import { INestApplication } from '@nestjs/common';
import * as pactum from 'pactum';
import { clearE2eApp, setE2eApp } from './e2e-context';

let appFactory: import('./app.factory').AppFactory;
let app: INestApplication;

global.beforeEach(async () => {
  const { AppFactory } = await import('./app.factory');
  appFactory = await AppFactory.init();
  await appFactory.initDB();
  app = appFactory.instance;
  setE2eApp(app);

  pactum.request.setBaseUrl(await app.getUrl());
  global.pactum = pactum;
  global.spec = pactum.spec();
  // Booting the full AppModule per test can exceed Jest's 5s hook default on a
  // loaded CI runner; give the setup hook headroom so app init never flakes.
}, 30000);

global.afterEach(async () => {
  try {
    await appFactory?.destory();
  } finally {
    clearE2eApp();
  }
});
