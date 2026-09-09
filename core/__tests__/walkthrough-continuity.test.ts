import { expect, test } from 'vite-plus/test';
import { formatStopContinuity, getStopContinuity } from '../lib/walkthrough-continuity.ts';
import type { WalkthroughHunk } from '../types.ts';

const hunk = (path: string, additionStart: number, additionEnd: number): WalkthroughHunk => ({
  added: 1,
  additionEnd,
  additionStart,
  anchor: {
    display: `${path}:${additionStart}-${additionEnd}`,
    endLine: additionEnd,
    sectionId: `${path}:pull-request`,
    sectionKind: 'pull-request',
    side: 'both',
    startLine: additionStart,
  },
  deleted: 0,
  id: `${path}:pull-request:h1`,
  path,
  status: 'modified',
});

test('a stop reports the files that moved since the last review round', () => {
  const hunks = [hunk('src/settings.ts', 1, 20), hunk('src/physics.ts', 5, 9)];

  expect(getStopContinuity(hunks, new Set(['src/physics.ts']), []).changed).toBe(true);
  expect(getStopContinuity(hunks, new Set(['src/unrelated.ts']), []).changed).toBe(false);
  expect(getStopContinuity(hunks, new Set(), []).changed).toBe(false);
});

test('a stop counts only the settled conversations that land inside it', () => {
  const hunks = [hunk('src/settings.ts', 10, 20)];

  expect(
    getStopContinuity(hunks, new Set(), [
      { filePath: 'src/settings.ts', lineNumber: 12 },
      { filePath: 'src/settings.ts', lineNumber: 20 },
    ]).settled,
  ).toBe(2);

  // The right file at the wrong line, and the right line in the wrong file,
  // both belong to some other stop.
  expect(
    getStopContinuity(hunks, new Set(), [
      { filePath: 'src/settings.ts', lineNumber: 21 },
      { filePath: 'src/physics.ts', lineNumber: 12 },
    ]).settled,
  ).toBe(0);
});

test('the continuity label says nothing when there is nothing to say', () => {
  expect(formatStopContinuity({ changed: false, settled: 0 })).toBe('');
  expect(formatStopContinuity({ changed: true, settled: 0 })).toBe('changed since last review');
  expect(formatStopContinuity({ changed: false, settled: 3 })).toBe('3 settled');
  expect(formatStopContinuity({ changed: true, settled: 1 })).toBe(
    'changed since last review · 1 settled',
  );
});
