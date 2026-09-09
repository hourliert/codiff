import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { compilePathPatterns, matchesPathPatterns } = require('../lib/path-patterns.cjs') as {
  compilePathPatterns: (patterns: ReadonlyArray<string> | undefined) => Array<unknown>;
  matchesPathPatterns: (patterns: ReadonlyArray<unknown>, path: string) => boolean;
};

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
