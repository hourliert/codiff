import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);

let home = '';
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'codiff-walkthrough-store-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (previousHome == null) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  rmSync(home, { force: true, recursive: true });
});

const loadStore = () => {
  const path = require.resolve('../walkthrough-store.cjs');
  delete require.cache[path];
  return require('../walkthrough-store.cjs') as typeof import('../walkthrough-store.cjs');
};

const sampleWalkthrough = () =>
  ({
    agent: 'claude',
    chapters: [
      {
        blurb: '',
        icon: 'gear',
        id: 'runtime',
        stops: [
          {
            added: 1,
            deleted: 1,
            hunkIds: ['src/app.ts:staged:h1'],
            hunks: [
              {
                added: 1,
                deleted: 1,
                id: 'src/app.ts:staged:h1',
                path: 'src/app.ts',
                status: 'modified',
              },
            ],
            id: 'behavior',
            importance: 'normal',
            prose: 'Review the behavior.',
            title: 'Behavior',
          },
        ],
        title: 'Runtime',
      },
    ],
    focus: 'Walk through the change.',
    generatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'narrative',
    repo: { branch: 'main', root: '/repo' },
    source: { type: 'working-tree' },
    support: [],
    title: 'Walkthrough',
    version: 4,
  }) as never;

const scope = (source: unknown = { type: 'working-tree' }) =>
  ({ repoRoot: '/repo', source }) as never;

const pullRequestScope = (number: number, headSha?: string) =>
  scope({
    number,
    owner: 'gt-coach',
    projectPath: 'gt-coach/gt-coach-monorepo',
    repo: 'gt-coach-monorepo',
    type: 'pull-request',
    url: `https://github.com/gt-coach/gt-coach-monorepo/pull/${number}`,
    ...(headSha ? { headSha } : {}),
  });

test('round-trips an exact cache entry', () => {
  const store = loadStore();
  const cacheKey = 'exact-input-key';
  store.writeStoredWalkthrough(scope(), cacheKey, sampleWalkthrough());

  expect(existsSync(store.getWalkthroughStorePath(scope(), cacheKey))).toBe(true);
  expect(store.readStoredWalkthrough(scope(), cacheKey)?.title).toBe('Walkthrough');
  expect(store.readStoredWalkthrough(scope(), 'different-input-key')).toBe(null);
});

test('replaces an existing cache entry', () => {
  const store = loadStore();
  const cacheKey = 'exact-input-key';
  store.writeStoredWalkthrough(scope(), cacheKey, sampleWalkthrough());
  store.writeStoredWalkthrough(scope(), cacheKey, {
    ...sampleWalkthrough(),
    title: 'Updated walkthrough',
  });

  expect(store.readStoredWalkthrough(scope(), cacheKey)?.title).toBe('Updated walkthrough');
});

test('rejects malformed and incompatible cache records', () => {
  const store = loadStore();
  const cacheKey = 'exact-input-key';
  const path = store.getWalkthroughStorePath(scope(), cacheKey);
  mkdirSync(store.getWalkthroughScopeDir(scope()), { recursive: true });

  writeFileSync(path, '{ not json');
  expect(store.readStoredWalkthrough(scope(), cacheKey)).toBe(null);

  // The layout this replaces. Version 1 entries must not be read as version 2
  // records, which carry facts they never recorded.
  writeFileSync(path, JSON.stringify({ cacheKey, version: 1, walkthrough: sampleWalkthrough() }));
  expect(store.readStoredWalkthrough(scope(), cacheKey)).toBe(null);

  writeFileSync(
    path,
    JSON.stringify({
      cacheKey,
      version: 2,
      walkthrough: { ...sampleWalkthrough(), version: 3 },
      writtenAt: Date.now(),
    }),
  );
  expect(store.readStoredWalkthrough(scope(), cacheKey)).toBe(null);

  // A version 2 record without a written-at cannot be ordered against another
  // round, which is the only reason to keep it.
  writeFileSync(path, JSON.stringify({ cacheKey, version: 2, walkthrough: sampleWalkthrough() }));
  expect(store.readStoredWalkthrough(scope(), cacheKey)).toBe(null);
});

test('files each pull request separately and finds its last round', () => {
  const store = loadStore();
  store.writeStoredWalkthrough(pullRequestScope(1396, 'head-one'), 'round-one', {
    ...sampleWalkthrough(),
    title: 'Round one',
  });
  store.writeStoredWalkthrough(pullRequestScope(1396, 'head-two'), 'round-two', {
    ...sampleWalkthrough(),
    title: 'Round two',
  });
  store.writeStoredWalkthrough(pullRequestScope(1397, 'other-head'), 'other-pr', {
    ...sampleWalkthrough(),
    title: 'A different pull request',
  });

  // The head under review now is round two, so its own entry is not its
  // previous round -- round one is.
  const previous = store.readLatestStoredWalkthrough(pullRequestScope(1396), 'round-two');
  expect(previous?.walkthrough.title).toBe('Round one');
  expect(previous?.headSha).toBe('head-one');

  // A neighbouring pull request is not a previous round of this one.
  expect(store.readLatestStoredWalkthrough(pullRequestScope(1397), 'other-pr')).toBe(null);
  // Nor is a working tree review of the same repository.
  expect(store.readLatestStoredWalkthrough(scope())).toBe(null);
});

test('records the model and the head each round reviewed', () => {
  const store = loadStore();
  store.writeStoredWalkthrough(
    pullRequestScope(1396, 'head-one'),
    'round-one',
    sampleWalkthrough(),
    {
      model: 'claude-opus-5',
    },
  );

  const record = store.readLatestStoredWalkthrough(pullRequestScope(1396));
  expect(record).toMatchObject({ agent: 'claude', headSha: 'head-one', model: 'claude-opus-5' });
  expect(record?.writtenAt).toBeGreaterThan(0);
});

test('keeps only the most recent rounds of a pull request', () => {
  const store = loadStore();
  const scopeForRound = pullRequestScope(1396, 'head');
  for (let round = 0; round < store.MAX_STORED_WALKTHROUGHS_PER_SOURCE + 3; round++) {
    store.writeStoredWalkthrough(scopeForRound, `round-${round}`, {
      ...sampleWalkthrough(),
      title: `Round ${round}`,
    });
  }

  // Retention is per round rather than per diff now, so without a sweep this
  // directory would grow with every push.
  expect(readdirSync(store.getWalkthroughScopeDir(scopeForRound)).length).toBe(
    store.MAX_STORED_WALKTHROUGHS_PER_SOURCE,
  );
  expect(store.readStoredWalkthrough(scopeForRound, 'round-0')).toBe(null);
  expect(store.readStoredWalkthrough(scopeForRound, 'round-7')?.title).toBe('Round 7');
});

test('sweeps away the flat entries the previous layout left behind', () => {
  const store = loadStore();
  const legacyDirectory = join(home, '.codiff', 'walkthroughs');
  mkdirSync(legacyDirectory, { recursive: true });
  const legacyPath = join(legacyDirectory, 'a'.repeat(64) + '.json');
  writeFileSync(
    legacyPath,
    JSON.stringify({ cacheKey: 'old', version: 1, walkthrough: sampleWalkthrough() }),
  );

  store.writeStoredWalkthrough(pullRequestScope(1396, 'head'), 'round-one', sampleWalkthrough());

  // Unreadable under the new envelope and unrewritable -- the file never
  // recorded which repository it belonged to.
  expect(existsSync(legacyPath)).toBe(false);
});
