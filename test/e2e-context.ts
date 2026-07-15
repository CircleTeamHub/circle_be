import type { INestApplication } from '@nestjs/common';

let currentApp: INestApplication | undefined;

export function setE2eApp(app: INestApplication): void {
  currentApp = app;
}

export function clearE2eApp(): void {
  currentApp = undefined;
}

export function getE2eApp(): INestApplication {
  if (!currentApp) {
    throw new Error('E2E application is not initialized');
  }
  return currentApp;
}
