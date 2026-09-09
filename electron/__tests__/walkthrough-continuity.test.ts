import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironmentForSubprocess } from '../../core/__tests__/helpers/git.ts';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { readPathsChangedSince, readPreviousRound } = require('../walkthrough-continuity.cjs') as {
  readPathsChangedSince: (
    repoRoot: string,
    previousHeadSha: string | undefined,
    headSha: string | undefined,
  ) => Promise<ReadonlyArray<string>>;
  readPreviousRound: (
    repoRoot: string,
    source: unknown,
    previousRecord: { headSha?: string; writtenAt: number } | null,
  ) => Promise<{ changedPaths: ReadonlyArray<string>; headSha: string } | undefined>;
};

const execFileAsync = promisify(execFile);

const createRepository = async () => {
  const directory = await createTemporaryDirectory('codiff-continuity-');
  const run = async (...args: ReadonlyArray<string>) => {
    const { stdout } = await execFileAsync('git', ['-C', directory.path, ...args], {
      env: { ...process.env, ...getGitTestEnvironmentForSubprocess() },
    });
    return stdout.trim();
  };
  await run('init', '-b', 'main');
  await run('config', 'user.email', 'test@example.com');
  await run('config', 'user.name', 'Test');

  const commit = async (files: Record<string, string>, message: string) => {
    for (const [path, contents] of Object.entries(files)) {
      await writeFile(join(directory.path, path), contents);
    }
    await run('add', '-A');
    await run('commit', '-m', message);
    return run('rev-parse', 'HEAD');
  };
  return { commit, directory, run };
};

const pullRequestSource = (headSha: string) => ({
  headSha,
  number: 1396,
  owner: 'gt-coach',
  repo: 'gt-coach-monorepo',
  type: 'pull-request',
  url: 'https://github.com/gt-coach/gt-coach-monorepo/pull/1396',
});

test('reports the files the agent changed between two review rounds', async () => {
  const repository = await createRepository();
  await using directory = repository.directory;
  const first = await repository.commit(
    { 'kept.ts': 'stable\n', 'moved.ts': 'before\n' },
    'round one',
  );
  const second = await repository.commit({ 'moved.ts': 'after\n' }, 'round two');

  expect(await readPathsChangedSince(directory.path, first, second)).toEqual(['moved.ts']);
  // Nothing to say when the review is looking at the same head it looked at
  // last time, which is every reopen that has no new push behind it.
  expect(await readPathsChangedSince(directory.path, second, second)).toEqual([]);
  expect(await readPathsChangedSince(directory.path, undefined, second)).toEqual([]);
});

test('degrades to no signal when the previous head is gone', async () => {
  const repository = await createRepository();
  await using directory = repository.directory;
  const head = await repository.commit({ 'file.ts': 'contents\n' }, 'only commit');

  // An agent force-pushing leaves the head a previous round reviewed
  // unreachable. That must cost the signal, never the walkthrough.
  expect(await readPathsChangedSince(directory.path, '0'.repeat(40), head)).toEqual([]);
});

test('describes the previous round only when something moved', async () => {
  const repository = await createRepository();
  await using directory = repository.directory;
  const first = await repository.commit({ 'moved.ts': 'before\n' }, 'round one');
  const second = await repository.commit({ 'moved.ts': 'after\n' }, 'round two');

  expect(
    await readPreviousRound(directory.path, pullRequestSource(second), {
      headSha: first,
      writtenAt: 10,
    }),
  ).toEqual({ changedPaths: ['moved.ts'], headSha: first, reviewedAt: 10 });

  // No stored round, the same head as the stored round, and a working tree
  // review all mean there is no earlier round to compare against.
  expect(await readPreviousRound(directory.path, pullRequestSource(second), null)).toBe(undefined);
  expect(
    await readPreviousRound(directory.path, pullRequestSource(second), {
      headSha: second,
      writtenAt: 10,
    }),
  ).toBe(undefined);
  expect(
    await readPreviousRound(
      directory.path,
      { type: 'working-tree' },
      {
        headSha: first,
        writtenAt: 10,
      },
    ),
  ).toBe(undefined);
});
