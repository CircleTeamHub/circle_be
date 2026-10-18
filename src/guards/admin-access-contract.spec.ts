import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { ADMIN_ROLE_PERMISSIONS } from 'src/admin-access/admin-permission.guard';

const permissions = new Set(Object.values(ADMIN_ROLE_PERMISSIONS).flat());
function controllerFiles(dir: string): string[] {
  // Paths come exclusively from the repository source tree.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === 'generated' ? [] : controllerFiles(path);
    return path.endsWith('.controller.ts') ? [path] : [];
  });
}
function calls(node: ts.Node): ts.CallExpression[] {
  return (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [])
    .map((d) => d.expression)
    .filter(ts.isCallExpression);
}
function named(list: ts.CallExpression[], name: string): ts.CallExpression[] {
  return list.filter(
    (c) => ts.isIdentifier(c.expression) && c.expression.text === name,
  );
}
function values(call: ts.CallExpression): string[] {
  return call.arguments.map((arg) => {
    if (ts.isStringLiteral(arg) || ts.isIdentifier(arg)) return arg.text;
    return '';
  });
}

it('requires every admin HTTP handler to have both the permission guard and a known permission', () => {
  let checked = 0;
  for (const file of controllerFiles(join(process.cwd(), 'src'))) {
    // Paths are supplied by controllerFiles, never by request data.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const content = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
    );
    for (const cls of source.statements.filter(ts.isClassDeclaration)) {
      const classCalls = calls(cls);
      if (
        !named(classCalls, 'Controller').some((c) =>
          values(c).some(
            (path) => path === 'admin' || path.startsWith('admin/'),
          ),
        )
      )
        continue;
      for (const method of cls.members.filter(ts.isMethodDeclaration)) {
        const methodCalls = calls(method);
        if (
          !methodCalls.some(
            (c) =>
              ts.isIdentifier(c.expression) &&
              [
                'Get',
                'Post',
                'Put',
                'Patch',
                'Delete',
                'Head',
                'Options',
                'All',
              ].includes(c.expression.text),
          )
        )
          continue;
        const all = [...methodCalls, ...classCalls];
        const guards = named(all, 'UseGuards').flatMap(values);
        const permission =
          named(methodCalls, 'RequireAdminPermission')[0] ??
          named(classCalls, 'RequireAdminPermission')[0];
        const identity = `${cls.name?.text}.${method.name.getText(source)}`;
        expect({ identity, guards }).toEqual(
          expect.objectContaining({
            guards: expect.arrayContaining([
              'AdminGuard',
              'AdminPermissionGuard',
            ]),
          }),
        );
        expect({
          identity,
          permission:
            permission && permissions.has(values(permission)[0] as any),
        }).toEqual({ identity, permission: true });
        expect(named(all, 'AnonymousAccess')).toHaveLength(0);
        checked++;
      }
    }
  }
  expect(checked).toBeGreaterThan(0);
});
