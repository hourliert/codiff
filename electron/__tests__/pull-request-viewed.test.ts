import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { readPullRequestViewedState, setPullRequestFileViewed } =
  require('../git-state/pull-request.cjs') as {
    readPullRequestViewedState: (
      repoRoot: string,
      pullRequest: { number: number; owner: string; repo: string; url: string },
    ) => Promise<Array<string>>;
    setPullRequestFileViewed: (
      launchPath: string,
      request: {
        path: string;
        source: { provider: 'github'; type: 'pull-request'; url: string };
        viewed: boolean;
      },
    ) => Promise<void>;
  };

const execFileAsync = promisify(execFile);

const createRepositoryWithGh = async (prefix: string, script: string) => {
  const directory = await createTemporaryDirectory(prefix);
  const repo = join(directory.path, 'repo');
  const fakeGh = join(directory.path, 'gh');
  const callsPath = join(directory.path, 'calls.txt');

  await mkdir(repo);
  await execFileAsync('git', ['-C', repo, 'init']);
  await writeFile(
    fakeGh,
    // Flattened to one line per call so a multi-line GraphQL document does not
    // split a single invocation across several recorded entries.
    `#!/bin/sh\nprintf '%s\\n' "$(printf '%s' "$*" | tr '\\n' ' ')" >> "$CODIFF_GITHUB_COMMAND_TEST_CALLS"\n${script}`,
  );
  await chmod(fakeGh, 0o755);

  return { callsPath, directory, fakeGh, repo };
};

const readCalls = async (callsPath: string) =>
  (await readFile(callsPath, 'utf8')).trim().split('\n');

test('reads every page of viewed state and counts only files still marked viewed', async () => {
  const { callsPath, directory, fakeGh, repo } = await createRepositoryWithGh(
    'codiff-gh-viewed-read-',
    `case "$*" in
  *cursor=SECOND*)
    printf '%s' '{"data":{"repository":{"pullRequest":{"id":"PR_node","files":{"nodes":[{"path":"c.ts","viewerViewedState":"VIEWED"},{"path":"d.ts","viewerViewedState":"DISMISSED"}],"pageInfo":{"endCursor":null,"hasNextPage":false}}}}}}'
    ;;
  *viewerViewedState*)
    printf '%s' '{"data":{"repository":{"pullRequest":{"id":"PR_node","files":{"nodes":[{"path":"a.ts","viewerViewedState":"VIEWED"},{"path":"b.ts","viewerViewedState":"UNVIEWED"}],"pageInfo":{"endCursor":"SECOND","hasNextPage":true}}}}}}'
    ;;
  *) printf '%s' '{}' ;;
esac
`,
  );
  await using _directory = directory;
  await using _environment = createTemporaryEnvironment({
    CODIFF_GH_PATH: fakeGh,
    CODIFF_GITHUB_COMMAND_TEST_CALLS: callsPath,
    SHELL: undefined,
  });

  // `DISMISSED` means the file was viewed and has changed since, which is
  // exactly the state Codiff renders as unviewed.
  expect(
    await readPullRequestViewedState(repo, {
      number: 12,
      owner: 'nkzw-tech',
      repo: 'codiff',
      url: 'https://github.com/nkzw-tech/codiff/pull/12',
    }),
  ).toEqual(['a.ts', 'c.ts']);

  expect((await readCalls(callsPath)).length).toBe(2);
});

test('a failed viewed lookup reports nothing viewed rather than failing the review', async () => {
  const { callsPath, directory, fakeGh, repo } = await createRepositoryWithGh(
    'codiff-gh-viewed-error-',
    "echo 'gh: rate limit exceeded' >&2\nexit 1\n",
  );
  await using _directory = directory;
  await using _environment = createTemporaryEnvironment({
    CODIFF_GH_PATH: fakeGh,
    CODIFF_GITHUB_COMMAND_TEST_CALLS: callsPath,
    SHELL: undefined,
  });

  expect(
    await readPullRequestViewedState(repo, {
      number: 12,
      owner: 'nkzw-tech',
      repo: 'codiff',
      url: 'https://github.com/nkzw-tech/codiff/pull/12',
    }),
  ).toEqual([]);
});

test('viewing and unviewing a file send the matching mutation, resolving the node id once', async () => {
  const { callsPath, directory, fakeGh, repo } = await createRepositoryWithGh(
    'codiff-gh-viewed-write-',
    `case "$*" in
  *repos/nkzw-tech/codiff/pulls/34*)
    printf '%s' '{"node_id":"PR_node"}'
    ;;
  *) printf '%s' '{"data":{}}' ;;
esac
`,
  );
  await using _directory = directory;
  await using _environment = createTemporaryEnvironment({
    CODIFF_GH_PATH: fakeGh,
    CODIFF_GITHUB_COMMAND_TEST_CALLS: callsPath,
    SHELL: undefined,
  });

  const source = {
    provider: 'github' as const,
    type: 'pull-request' as const,
    url: 'https://github.com/nkzw-tech/codiff/pull/34',
  };
  await setPullRequestFileViewed(repo, { path: 'a.ts', source, viewed: true });
  await setPullRequestFileViewed(repo, { path: 'a.ts', source, viewed: false });

  const calls = await readCalls(callsPath);
  // The node id is immutable, so a review that toggles many files pays for the
  // lookup once.
  expect(calls.filter((call) => call.includes('repos/nkzw-tech/codiff/pulls/34')).length).toBe(1);
  expect(calls.filter((call) => call.includes(' markFileAsViewed(')).length).toBe(1);
  expect(calls.filter((call) => call.includes(' unmarkFileAsViewed(')).length).toBe(1);
  expect(calls.filter((call) => call.includes('pullRequestId=PR_node')).length).toBe(2);
  expect(calls.filter((call) => call.includes('path=a.ts')).length).toBe(2);
});
