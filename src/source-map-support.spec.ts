import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

describe('production source maps', () => {
  it('maps a compiled JavaScript stack frame back to TypeScript', () => {
    const directory = mkdtempSync(join(tmpdir(), 'circle-source-map-'));
    const sourceName = 'compiled-source-map-probe.ts';
    const result = ts.transpileModule(
      `function fail() { throw new Error('probe'); }\nfail();`,
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, sourceMap: true },
        fileName: sourceName,
      },
    );
    const outputPath = join(directory, 'compiled-source-map-probe.js');
    // Paths are generated inside a new OS temp directory, never from input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(outputPath, result.outputText);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(`${outputPath}.map`, result.sourceMapText!);

    const child = spawnSync(
      process.execPath,
      ['-r', 'source-map-support/register', outputPath],
      {
        encoding: 'utf8',
        cwd: process.cwd(),
      },
    );

    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain(sourceName);
    expect(child.stderr).not.toContain('probe.js:');
  });
});
