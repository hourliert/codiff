import { expect, test } from 'vite-plus/test';
import { getWalkthroughReviewKeyPrefix } from '../lib/review-identity.ts';
import { getViewedFileDelta, mergeHostViewed } from '../lib/viewed.ts';
import type { ChangedFile } from '../types.ts';

const createFile = (path: string, fingerprint: string): ChangedFile => ({
  fingerprint,
  path,
  sections: [],
  status: 'modified',
});

const hunkKey = (path: string, hunkId: string) =>
  `${getWalkthroughReviewKeyPrefix(path)}${JSON.stringify(hunkId)}`;

const files = [createFile('a.ts', 'fp-a'), createFile('b.ts', 'fp-b'), createFile('c.ts', 'fp-c')];

test('the host decides which whole files count as viewed', () => {
  const merged = mergeHostViewed(files, { 'b.ts': 'fp-b' }, ['a.ts']);

  // `a.ts` arrives viewed from the host even though nothing local said so, and
  // the stale local mark on `b.ts` loses to the host saying it is unviewed.
  expect(merged['a.ts']).toBe('fp-a');
  expect(merged['b.ts']).toBe(undefined);
});

test('a host mark carries the current fingerprint, so a new push re-views untouched files', () => {
  // Every file's fingerprint carries the head SHA, so a push invalidates the
  // whole local cache. The host keeps its per-file record, which is finer.
  const afterPush = [createFile('a.ts', 'fp-a-2'), createFile('b.ts', 'fp-b-2')];
  const merged = mergeHostViewed(afterPush, { 'a.ts': 'fp-a' }, ['a.ts']);

  expect(merged['a.ts']).toBe('fp-a-2');
});

test('local per-block marks survive, but only where the host has no whole-file mark', () => {
  const local = {
    [hunkKey('a.ts', 'h1')]: 'fp-a',
    [hunkKey('c.ts', 'h9')]: 'fp-c',
  };
  const merged = mergeHostViewed(files, local, ['a.ts']);

  // A whole-file mark supersedes the blocks under it, matching what a
  // whole-file toggle does locally.
  expect(merged[hunkKey('a.ts', 'h1')]).toBe(undefined);
  expect(merged[hunkKey('c.ts', 'h9')]).toBe('fp-c');
});

test('without a host answer the local state is used as it stands', () => {
  const local = { 'b.ts': 'fp-b', [hunkKey('a.ts', 'h1')]: 'fp-a' };

  expect(mergeHostViewed(files, local, undefined)).toEqual(local);
});

test('only whole-file transitions are reported to the host', () => {
  expect(
    getViewedFileDelta(files, {}, { 'a.ts': 'fp-a', [hunkKey('b.ts', 'h1')]: 'fp-b' }),
  ).toEqual([{ path: 'a.ts', viewed: true }]);

  expect(getViewedFileDelta(files, { 'a.ts': 'fp-a' }, {})).toEqual([
    { path: 'a.ts', viewed: false },
  ]);

  // A stale fingerprint was never viewed for this revision, so clearing it is
  // not a transition the host needs to hear about.
  expect(getViewedFileDelta(files, { 'a.ts': 'stale' }, {})).toEqual([]);
});
