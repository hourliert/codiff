import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import {
  getGitTestEnvironmentForSubprocess,
  withGitTestEnvironment,
} from '../../core/__tests__/helpers/git.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

type PullRequestSource = {
  headSha?: string;
  number: number;
  provider: 'github' | 'gitlab';
  type: 'pull-request';
  url: string;
};

const require = createRequire(import.meta.url);
const { getReviewWorktreePath, resolveReviewContentRoot } = require('../review-worktree.cjs') as {
  getReviewWorktreePath: (repoRoot: string, source: PullRequestSource) => string;
  resolveReviewContentRoot: (
    repoRoot: string,
    source?: { type: string } | PullRequestSource,
  ) => Promise<string | undefined>;
};

const execFileAsync = promisify(execFile);

const run = (repo: string, args: ReadonlyArray<string>) =>
  execFileAsync('git', ['-C', repo, ...args], { env: getGitTestEnvironmentForSubprocess() });

const commit = async (repo: string, path: string, contents: string, message: string) => {
  await writeFile(join(repo, path), contents);
  await run(repo, ['add', '.']);
  await run(repo, ['commit', '-m', message]);
  return (await run(repo, ['rev-parse', 'HEAD'])).stdout.trim();
};

const createRepository = async (prefix: string) => {
  const directory = await createTemporaryDirectory(prefix);
  const repo = join(directory.path, 'repo');
  await execFileAsync('git', ['init', repo], { env: getGitTestEnvironmentForSubprocess() });
  await run(repo, ['remote', 'add', 'origin', 'git@github.com:nkzw-tech/codiff.git']);
  return { directory, repo };
};

const createSource = (headSha: string, number = 7): PullRequestSource => ({
  headSha,
  number,
  provider: 'github',
  type: 'pull-request',
  url: `https://github.com/nkzw-tech/codiff/pull/${number}`,
});

test('a pull request review reads its own head commit, not the reviewer’s checkout', async () => {
  const { directory, repo } = await createRepository('codiff-worktree-head-');
  await using _directory = directory;
  await using _home = createTemporaryEnvironment({ HOME: directory.path });

  await withGitTestEnvironment(async () => {
    const base = await commit(repo, 'app.ts', 'export const value = 1;\n', 'base');
    await run(repo, ['checkout', '-q', '-b', 'feature']);
    const head = await commit(repo, 'app.ts', 'export const value = 2;\n', 'feature');
    // The reviewer is sitting on the base branch, which is the situation that
    // used to hand back the wrong revision of the file.
    await run(repo, ['checkout', '-q', base]);

    const root = await resolveReviewContentRoot(repo, createSource(head));
    expect(root).toBe(getReviewWorktreePath(repo, createSource(head)));
    expect(root).not.toBe(repo);
    expect(await readFile(join(root!, 'app.ts'), 'utf8')).toBe('export const value = 2;\n');
    // The reviewer's own checkout is untouched.
    expect(await readFile(join(repo, 'app.ts'), 'utf8')).toBe('export const value = 1;\n');
  });
});

test('a new push re-points the existing checkout instead of adding another one', async () => {
  const { directory, repo } = await createRepository('codiff-worktree-repoint-');
  await using _directory = directory;
  await using _home = createTemporaryEnvironment({ HOME: directory.path });

  await withGitTestEnvironment(async () => {
    const base = await commit(repo, 'app.ts', 'first\n', 'base');
    await run(repo, ['checkout', '-q', '-b', 'feature']);
    const first = await commit(repo, 'app.ts', 'second\n', 'first push');
    const second = await commit(repo, 'app.ts', 'third\n', 'second push');
    await run(repo, ['checkout', '-q', base]);

    const before = await resolveReviewContentRoot(repo, createSource(first));
    expect(await readFile(join(before!, 'app.ts'), 'utf8')).toBe('second\n');

    const after = await resolveReviewContentRoot(repo, createSource(second));
    expect(after).toBe(before);
    expect(await readFile(join(after!, 'app.ts'), 'utf8')).toBe('third\n');

    const worktrees = (await run(repo, ['worktree', 'list', '--porcelain'])).stdout;
    expect(worktrees.match(/^worktree /gmu)?.length).toBe(2);
  });
});

test('a checkout already sitting on the head commit is used as it is', async () => {
  const { directory, repo } = await createRepository('codiff-worktree-local-');
  await using _directory = directory;
  await using _home = createTemporaryEnvironment({ HOME: directory.path });

  await withGitTestEnvironment(async () => {
    const head = await commit(repo, 'app.ts', 'value\n', 'head');

    // Nothing to materialize, and the reviewer's own files are the better
    // target because they can be edited.
    expect(await resolveReviewContentRoot(repo, createSource(head))).toBe(repo);

    // Once that checkout drifts it no longer represents the review.
    await writeFile(join(repo, 'app.ts'), 'edited\n');
    expect(await resolveReviewContentRoot(repo, createSource(head))).toBe(
      getReviewWorktreePath(repo, createSource(head)),
    );
  });
});

test('the checkout store keeps a bounded number of reviews per repository', async () => {
  const { directory, repo } = await createRepository('codiff-worktree-prune-');
  await using _directory = directory;
  await using _home = createTemporaryEnvironment({ HOME: directory.path });

  await withGitTestEnvironment(async () => {
    const base = await commit(repo, 'app.ts', 'base\n', 'base');
    await run(repo, ['checkout', '-q', '-b', 'feature']);
    const heads: Array<string> = [];
    for (const index of [1, 2, 3, 4]) {
      heads.push(await commit(repo, 'app.ts', `revision ${index}\n`, `push ${index}`));
    }
    await run(repo, ['checkout', '-q', base]);

    const paths: Array<string> = [];
    for (const [index, head] of heads.entries()) {
      const root = await resolveReviewContentRoot(repo, createSource(head, index + 1));
      paths.push(root!);
    }

    const worktrees = (await run(repo, ['worktree', 'list', '--porcelain'])).stdout;
    // The main checkout plus the cap.
    expect(worktrees.match(/^worktree /gmu)?.length).toBe(4);
    // The oldest review is the one that was retired.
    expect(worktrees.includes(paths[0])).toBe(false);
    expect(worktrees.includes(paths[3])).toBe(true);
  });
});

test('local sources and unresolvable reviews never reach a checkout', async () => {
  const { directory, repo } = await createRepository('codiff-worktree-skip-');
  await using _directory = directory;
  await using _home = createTemporaryEnvironment({ HOME: directory.path });

  await withGitTestEnvironment(async () => {
    await commit(repo, 'app.ts', 'value\n', 'base');

    expect(await resolveReviewContentRoot(repo, { type: 'working-tree' })).toBe(repo);
    expect(await resolveReviewContentRoot(repo, undefined)).toBe(repo);
    // GitLab merge requests keep the previous behaviour; only GitHub reviews
    // carry a head commit Codiff knows how to fetch.
    expect(
      await resolveReviewContentRoot(repo, { ...createSource('unused'), provider: 'gitlab' }),
    ).toBe(repo);
    // Without a head commit there is no revision to pin, and opening the
    // working tree instead would be the very bug this replaces.
    expect(
      await resolveReviewContentRoot(repo, { ...createSource('unused'), headSha: undefined }),
    ).toBe(undefined);
  });
});
