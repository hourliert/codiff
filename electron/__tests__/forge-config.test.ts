import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const config = require('../../forge.config.cjs') as {
  hooks: { packageAfterCopy: (forgeConfig: unknown, buildPath: string) => Promise<void> };
  packagerConfig: { ignore: ReadonlyArray<RegExp> };
};

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const CORE_REQUIRE = /require\(['"](\.\.\/core\/[^'"]+)['"]\)/gu;

test('desktop packaging excludes deterministic examples and screenshots', () => {
  expect(config.packagerConfig.ignore.some((pattern) => pattern.test('/examples'))).toBe(true);
  expect(
    config.packagerConfig.ignore.some((pattern) =>
      pattern.test('/examples/definition-navigation/screenshots/command-click.png'),
    ),
  ).toBe(true);
});

// `core` is excluded from the package and a hook copies part of it back, so a
// module the main process requires can be missing from a build that packaged
// without an error. It surfaces only when the built app is launched, as
// `Cannot find module`.
test('desktop packaging restores every core module the main process requires', async () => {
  const modules = new Set<string>();
  for (const name of await readdir(join(root, 'electron'))) {
    if (!name.endsWith('.cjs')) {
      continue;
    }
    const source = await readFile(join(root, 'electron', name), 'utf8');
    for (const [, path] of source.matchAll(CORE_REQUIRE)) {
      modules.add(path.replace('../', ''));
    }
  }
  // Without this the test passes on an empty set, which is the one result that
  // would mean the scan above stopped working.
  expect(modules.size).toBeGreaterThan(0);

  await using directory = await createTemporaryDirectory('codiff-package-');
  await config.hooks.packageAfterCopy({}, directory.path);

  expect([...modules].filter((path) => !existsSync(join(directory.path, path)))).toEqual([]);
});
