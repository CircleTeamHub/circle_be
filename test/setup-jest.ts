import * as pactum from 'pactum';
import { clearE2eApp, setE2eApp } from './e2e-context';

let appFactoryModule: typeof import('./app.factory');
let pendingApp:
  | {
      startup: Promise<import('./app.factory').AppFactory>;
      setup: Promise<void>;
    }
  | undefined;

global.beforeAll(async () => {
  // Give the cold ts-jest import its own budget before starting per-test apps.
  appFactoryModule = await import('./app.factory');
}, 60_000);

global.beforeEach(() => {
  const startup = appFactoryModule.AppFactory.init();
  const setup = startup.then(async (factory) => {
    await factory.initDB();
    const app = factory.instance;
    setE2eApp(app);

    pactum.request.setBaseUrl(await app.getUrl());
    global.pactum = pactum;
    global.spec = pactum.spec();
  });
  pendingApp = { startup, setup };
  return setup;
}, 30_000);

global.afterEach(async () => {
  const pending = pendingApp;
  pendingApp = undefined;
  try {
    // A timed-out Jest hook can still finish. Wait for its DB work before closing the app.
    await pending?.setup.catch(() => undefined);
    const factory = await pending?.startup.catch(() => undefined);
    await factory?.destory();
  } finally {
    clearE2eApp();
  }
}, 60_000);
