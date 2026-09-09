import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import packageJson from '../../package.json' with { type: 'json' };
import schema from '../config/codiff-config.schema.json' with { type: 'json' };
import { createDefaultConfig } from '../config/defaults.ts';
import { createTemporaryDirectorySync, createTemporaryEnvironment } from './helpers/resources.ts';

const require = createRequire(import.meta.url);
const {
  createDefaultConfig: createElectronDefaultConfig,
  readConfig,
  writeConfig,
} = require('../../electron/config.cjs') as {
  createDefaultConfig: typeof createDefaultConfig;
  readConfig: () => ReturnType<typeof createDefaultConfig>;
  writeConfig: (config: ReturnType<typeof createDefaultConfig>) => void;
};

const readElectronConfig = (raw: unknown) => {
  using home = createTemporaryDirectorySync('codiff-config-home.');
  using _environment = createTemporaryEnvironment({ HOME: home.path });
  const configDirectory = join(home.path, '.codiff');
  mkdirSync(configDirectory);
  writeFileSync(join(configDirectory, 'codiff.jsonc'), `${JSON.stringify(raw)}\n`);
  return readConfig();
};

const readElectronConfigText = (text: string) => {
  using home = createTemporaryDirectorySync('codiff-config-home.');
  using _environment = createTemporaryEnvironment({ HOME: home.path });
  const configDirectory = join(home.path, '.codiff');
  mkdirSync(configDirectory);
  writeFileSync(join(configDirectory, 'codiff.jsonc'), text);
  return readConfig();
};

const getSchemaDefaults = (section: 'keymap' | 'settings') =>
  Object.fromEntries(
    Object.entries(schema.properties[section].properties).map(([key, property]) => [
      key,
      property.default,
    ]),
  );

test('schema defaults match config defaults', () => {
  const defaults = createDefaultConfig();

  expect(getSchemaDefaults('settings')).toEqual(defaults.settings);
  expect(getSchemaDefaults('keymap')).toEqual(defaults.keymap);
});

test('electron and renderer defaults match', () => {
  expect(createElectronDefaultConfig()).toEqual(createDefaultConfig());
});

test('electron config normalizes code font settings', () => {
  expect(readElectronConfig({}).settings.codeFontFamily).toBe('');
  expect(readElectronConfig({}).settings.codeFontSize).toBe(13);

  expect(
    readElectronConfig({
      settings: {
        codeFontFamily: '  JetBrains Mono  ',
        codeFontSize: 14.6,
      },
    }).settings,
  ).toMatchObject({
    codeFontFamily: 'JetBrains Mono',
    codeFontSize: 15,
  });

  expect(
    readElectronConfig({ settings: { codeFontFamily: 42, codeFontSize: 'large' } }).settings,
  ).toMatchObject({
    codeFontFamily: '',
    codeFontSize: 13,
  });
  expect(readElectronConfig({ settings: { codeFontSize: 8 } }).settings.codeFontSize).toBe(10);
  expect(readElectronConfig({ settings: { codeFontSize: 99 } }).settings.codeFontSize).toBe(32);
});

test('electron config normalizes sidebar position', () => {
  expect(readElectronConfig({}).settings.sidebarPosition).toBe('left');
  expect(
    readElectronConfig({ settings: { sidebarPosition: 'right' } }).settings.sidebarPosition,
  ).toBe('right');
  expect(
    readElectronConfig({ settings: { sidebarPosition: 'bottom' } }).settings.sidebarPosition,
  ).toBe('left');
});

test('electron config keeps only usable auto-viewed patterns', () => {
  expect(readElectronConfig({}).settings.autoViewedPatterns).toEqual([]);
  expect(
    readElectronConfig({ settings: { autoViewedPatterns: ['**/*.test.ts', '!src/a.test.ts'] } })
      .settings.autoViewedPatterns,
  ).toEqual(['**/*.test.ts', '!src/a.test.ts']);
  // One unusable entry must not cost a reviewer the rest of their patterns.
  expect(
    readElectronConfig({ settings: { autoViewedPatterns: ['**/*.snap', '', 7, null] } }).settings
      .autoViewedPatterns,
  ).toEqual(['**/*.snap']);
  expect(
    readElectronConfig({ settings: { autoViewedPatterns: '**/*.snap' } }).settings
      .autoViewedPatterns,
  ).toEqual([]);
});

test('electron config records only answers the auto-viewed prompt can produce', () => {
  expect(readElectronConfig({}).settings.autoViewedSync).toBe('ask');
  for (const value of ['always', 'never', 'ask']) {
    expect(
      readElectronConfig({ settings: { autoViewedSync: value } }).settings.autoViewedSync,
    ).toBe(value);
  }
  expect(readElectronConfig({ settings: { autoViewedSync: 'yes' } }).settings.autoViewedSync).toBe(
    'ask',
  );
});

test('electron config keeps custom walkthrough prompt text only when it is a string', () => {
  expect(
    readElectronConfig({
      settings: {
        walkthroughPrompt: 'Respond in German with product-review terminology.',
      },
    }).settings.walkthroughPrompt,
  ).toBe('Respond in German with product-review terminology.');

  expect(
    readElectronConfig({
      settings: {
        walkthroughPrompt: ['Respond in German'],
      },
    }).settings.walkthroughPrompt,
  ).toBe('');
});

test('electron config strips trailing commas without changing strings', () => {
  const config = readElectronConfigText(`{
    // JSONC comments and trailing commas remain supported.
    "settings": {
      "walkthroughPrompt": "Preserve comma,} and comma,] with an escaped quote: \\"",
      "wordWrap": false,
    },
    "keymap": {
      "nextHunk": ["j", "n",],
    },
  }`);

  expect(config.settings.walkthroughPrompt).toBe(
    'Preserve comma,} and comma,] with an escaped quote: "',
  );
  expect(config.settings.wordWrap).toBe(false);
  expect(config.keymap.nextHunk).toEqual(['j', 'n']);
});

test('electron defaults load from packaged app shape', () => {
  const packageRoot = mkdtempSync(join(tmpdir(), 'codiff-package-shape.'));
  mkdirSync(join(packageRoot, 'config'));
  mkdirSync(join(packageRoot, 'electron'));
  copyFileSync('config/defaults.json', join(packageRoot, 'config/defaults.json'));
  copyFileSync('electron/config.cjs', join(packageRoot, 'electron/config.cjs'));

  const packageRequire = createRequire(join(packageRoot, 'electron/config.cjs'));
  expect(packageRequire('./config.cjs').createDefaultConfig()).toEqual(createDefaultConfig());
});

test('npm package includes runtime config and bundled skills', () => {
  expect(packageJson.files).toContain('config');
  expect(packageJson.files).toContain('codex');
  expect(packageJson.files).toContain('claude');
  expect(packageJson.files).toContain('opencode');
  expect(packageJson.files).toContain('pi');
});

test('writing config keeps edits made to the file since it was read', () => {
  using home = createTemporaryDirectorySync('codiff-config-write.');
  using _environment = createTemporaryEnvironment({ HOME: home.path });
  const configDirectory = join(home.path, '.codiff');
  mkdirSync(configDirectory);
  const configPath = join(configDirectory, 'codiff.jsonc');
  writeFileSync(configPath, `${JSON.stringify({ settings: {} })}\n`);

  // What a running instance loaded at start.
  const loaded = readConfig();

  // What the reviewer then edited by hand, which the instance never saw.
  writeFileSync(
    configPath,
    `${JSON.stringify({
      settings: { autoViewedPatterns: ['**/*.test.ts'], reviewCommentsPrefix: 'Edited' },
    })}\n`,
  );

  // Codiff writes for a reason of its own, such as falling back to a model.
  writeConfig({ ...loaded, settings: { ...loaded.settings, claudeModel: 'fallback-model' } });

  const result = readConfig();
  expect(result.settings.autoViewedPatterns).toEqual(['**/*.test.ts']);
  expect(result.settings.reviewCommentsPrefix).toBe('Edited');
  expect(result.settings.claudeModel).toBe('fallback-model');
});
