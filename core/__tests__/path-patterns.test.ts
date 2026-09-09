import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import { compilePathPatterns, matchesPathPatterns } from '../lib/path-patterns.js';

const matches = (patterns: ReadonlyArray<string>, path: string) =>
  matchesPathPatterns(compilePathPatterns(patterns), path);

test('a pattern without a slash applies to the file name wherever it sits', () => {
  expect(matches(['*.snap'], 'a/b/c.snap')).toBe(true);
  expect(matches(['*.snap'], 'c.snap')).toBe(true);
  expect(matches(['*.snap'], 'c.snap.ts')).toBe(false);
});

test('`**` spans directories and `*` stops at one', () => {
  expect(matches(['**/__tests__/**'], 'src/deep/__tests__/a/b.ts')).toBe(true);
  expect(matches(['**/*.test.ts'], 'a/b/c.test.ts')).toBe(true);
  // `**/x` also matches a bare `x`, so a pattern written for nested files still
  // covers the one at the root.
  expect(matches(['**/*.test.ts'], 'c.test.ts')).toBe(true);
  expect(matches(['src/*.ts'], 'src/nested/a.ts')).toBe(false);
});

test('a leading slash anchors and a trailing slash means everything beneath', () => {
  expect(matches(['/docs/'], 'docs/readme.md')).toBe(true);
  expect(matches(['/docs/'], 'packages/docs/readme.md')).toBe(false);
  // The directory itself is not a reviewable path; its contents are.
  expect(matches(['/docs/'], 'docs')).toBe(false);
});

test('a later negation re-includes what an earlier pattern swept up', () => {
  const patterns = ['**/*.test.ts', '!src/critical.test.ts'];
  expect(matches(patterns, 'src/other.test.ts')).toBe(true);
  expect(matches(patterns, 'src/critical.test.ts')).toBe(false);
  // Order decides, the same way it does in a .gitignore.
  expect(matches(['!src/critical.test.ts', '**/*.test.ts'], 'src/critical.test.ts')).toBe(true);
});

test('unusable patterns are skipped rather than failing the review', () => {
  expect(compilePathPatterns(['', '   ', '# a comment', '!'])).toEqual([]);
  expect(compilePathPatterns(undefined)).toEqual([]);
  expect(matches([], 'anything.ts')).toBe(false);
});

test('backslash-separated paths match the same patterns', () => {
  expect(matches(['**/__tests__/**'], String.raw`src\__tests__\a.ts`)).toBe(true);
});

test('the CommonJS and module builds stay in step', () => {
  const require = createRequire(import.meta.url);
  const cjs = require('../lib/path-patterns.cjs') as Record<string, unknown>;
  // Two copies exist so the main process can require it and the renderer can
  // import it; nothing keeps them honest except this.
  expect(Object.keys(cjs).sort()).toEqual(
    ['compilePathPattern', 'compilePathPatterns', 'matchesPathPatterns'].sort(),
  );
  const cjsMatches = cjs.matchesPathPatterns as typeof matchesPathPatterns;
  const cjsCompile = cjs.compilePathPatterns as typeof compilePathPatterns;
  for (const path of ['a/b.test.ts', 'src/critical.test.ts', 'docs/readme.md', 'src/index.ts']) {
    const patterns = ['**/*.test.ts', '/docs/', '!src/critical.test.ts'];
    expect(cjsMatches(cjsCompile(patterns), path)).toBe(matches(patterns, path));
  }
});
