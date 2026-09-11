import { expect, test } from 'vite-plus/test';
import { formatWalkthroughForExport } from '../lib/walkthrough-export.ts';
import type { NarrativeWalkthrough, WalkthroughHunk } from '../types.ts';

const hunk = (path: string, id: string, added: number): WalkthroughHunk => ({
  added,
  anchor: { display: path, sectionId: `${path}:pull-request`, side: 'both' },
  deleted: 0,
  id,
  path,
  status: 'modified',
});

const walkthrough: NarrativeWalkthrough = {
  agent: 'claude',
  chapters: [
    {
      blurb: 'The wire shapes both ends agree on.',
      icon: 'doc',
      id: 'contract',
      stops: [
        {
          added: 3,
          deleted: 0,
          hunkIds: ['h1'],
          hunks: [hunk('src/capture.ts', 'h1', 3)],
          id: 's1',
          importance: 'critical',
          prose: 'Binds every upload to one claim.',
          title: 'Bind every upload',
        },
      ],
      title: 'Contract',
    },
    {
      blurb: 'The routes a rig calls.',
      icon: 'path',
      id: 'api',
      stops: [
        {
          added: 1,
          deleted: 0,
          hunkIds: ['h2'],
          hunks: [hunk('src/routes.ts', 'h2', 1)],
          id: 's2',
          importance: 'normal',
          prose: 'Guards the routes with the rig token.',
          title: 'Guard the routes',
        },
      ],
      title: 'API',
    },
  ],
  focus: 'The cloud contract a rig talks to.',
  generatedAt: '2026-09-11T00:00:00.000Z',
  kind: 'narrative',
  repo: { branch: 'main', root: '/repo' },
  source: {
    number: 1395,
    title: 'feat(capture)',
    type: 'pull-request',
    url: 'https://github.com/owner/repo/pull/1395',
  } as NarrativeWalkthrough['source'],
  support: [
    {
      added: 5,
      deleted: 0,
      hunkIds: ['h3'],
      hunks: [hunk('pnpm-lock.yaml', 'h3', 5)],
      id: 'lock',
      reason: 'Lockfile',
    },
  ],
  thesis: 'It does what the description says.',
  title: 'Reference capture',
  version: 4,
};

test('exports the walkthrough structure and prose as text', () => {
  const text = formatWalkthroughForExport(walkthrough);

  expect(text).toContain('# Reference capture');
  expect(text).toContain(
    'Pull request: #1395 feat(capture) (https://github.com/owner/repo/pull/1395)',
  );
  expect(text).toContain('## Does it do what it says\n\nIt does what the description says.');
  expect(text).toContain('## Review focus\n\nThe cloud contract a rig talks to.');
  expect(text).toContain('## Contract (75% of the changed lines)');
  // Stops are numbered across chapters, as the walkthrough numbers them.
  expect(text).toContain('### 1. Bind every upload (critical)');
  expect(text).toContain('Files: src/capture.ts\n\nBinds every upload to one claim.');
  expect(text).toContain('### 2. Guard the routes (normal)');
  expect(text).toContain('- pnpm-lock.yaml (Lockfile)');
});

test('leaves out the thesis heading when there is no thesis', () => {
  const text = formatWalkthroughForExport({ ...walkthrough, thesis: undefined });

  expect(text).not.toContain('Does it do what it says');
  expect(text).toContain('## Review focus');
});
