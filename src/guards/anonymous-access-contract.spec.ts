import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

function controllers(dir: string): string[] {
  // Paths are derived only from the fixed repository source tree in this test.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated') return [];
      return controllers(path);
    }
    if (path.endsWith('.controller.ts')) return [path];
    return [];
  });
}

it('keeps the anonymous HTTP surface an explicit reviewed method allowlist', () => {
  const anonymous: string[] = [];
  for (const path of controllers(join(process.cwd(), 'src'))) {
    const source = ts.createSourceFile(
      path,
      // File paths come exclusively from the repository controller inventory above.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const cls of source.statements.filter(ts.isClassDeclaration)) {
      expect(
        (ts.getDecorators(cls) ?? []).some((d) =>
          d.expression.getText(source).startsWith('AnonymousAccess('),
        ),
      ).toBe(false);
      for (const method of cls.members) {
        const decorators = ts.canHaveDecorators(method)
          ? (ts.getDecorators(method) ?? [])
          : [];
        if (
          !decorators.some((d) =>
            d.expression.getText(source).startsWith('AnonymousAccess('),
          )
        )
          continue;
        const identity = `${cls.name?.text}.${method.name?.getText(source)}`;
        anonymous.push(identity);
        if (identity.startsWith('TempChatController.guest')) {
          expect(
            decorators.some((d) =>
              d.expression.getText(source).includes('TempChatGuestGuard'),
            ),
          ).toBe(true);
        }
      }
    }
  }
  const expected = [
    'AppOperationsController.update',
    'ConsoleToolController.tasks',
    'ConsoleToolController.pushes',
    'ConsoleToolController.timeline',
    'ConsoleToolController.analytics',
    'ConsoleToolController.diagnostics',
    'AuthController.register',
    'AuthController.login',
    'AuthController.adminLogin',
    'AuthController.verifyLoginChallenge',
    'AuthController.verifyLoginChallengeSecurityCode',
    'AuthController.resendLoginChallenge',
    'AuthController.loginChallengeStatus',
    'AuthController.refresh',
    'AuthController.adminRefresh',
    'AuthController.logout',
    'AuthController.requestPasswordReset',
    'AuthController.resetPassword',
    'TempChatController.meta',
    'TempChatController.join',
    'TempChatController.guestHistory',
    'TempChatController.guestMembers',
    'TempChatController.guestNote',
    'TempChatController.guestUploadPresign',
    'NoteShareLinkPublicController.resolveShareLink',
    'NotificationPublicController.revokePushToken',
    'CallWebhookController.handleLiveKitWebhook',
  ];
  anonymous.sort((a, b) => a.localeCompare(b));
  expected.sort((a, b) => a.localeCompare(b));
  expect(anonymous).toEqual(expected);
  const app = readFileSync(join(process.cwd(), 'src/app.module.ts'), 'utf8');
  expect(app).toContain('provide: APP_GUARD, useClass: DefaultAuthGuard');
});
