// @ts-check

const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { git, gitOrEmpty } = require('./git-state/common.cjs');
const {
  parseGitHubPullRequestUrl,
  selectPullRequestRemote,
} = require('./git-state/pull-request.cjs');

/**
 * @typedef {import('../core/types.ts').ReviewSource} ReviewSource
 * @typedef {Extract<ReviewSource, {type: 'pull-request'}>} PullRequestReviewSource
 */

/**
 * Checkouts are disposable, so they are cleaned up aggressively. A monorepo
 * checkout is hundreds of megabytes and a reviewer works through one or two
 * pull requests at a time; anything older than this was for a review that is
 * long finished.
 */
const MAX_WORKTREE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_WORKTREES_PER_REPOSITORY = 3;

const getWorktreeStoreDir = () => join(homedir(), '.codiff', 'worktrees');

/**
 * Two clones of the same repository must not share a checkout, so the
 * repository path is part of the key. The readable half is kept because this
 * path shows up in the reviewer's editor.
 *
 * @param {string} repoRoot
 */
const getRepositoryWorktreeDir = (repoRoot) => {
  const name = repoRoot.split(/[\\/]/u).filter(Boolean).pop() || 'repository';
  const digest = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
  return join(getWorktreeStoreDir(), `${sanitize(name)}-${digest}`);
};

/** @param {string} value */
const sanitize = (value) => value.replace(/[^\w.-]+/gu, '-').slice(0, 48) || 'review';

/** @param {PullRequestReviewSource} source */
const getReviewWorktreeName = (source) => {
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  return `${sanitize(pullRequest.owner)}-${sanitize(pullRequest.repo)}-pr-${pullRequest.number}`;
};

/** @param {string} repoRoot @param {PullRequestReviewSource} source */
const getReviewWorktreePath = (repoRoot, source) =>
  join(getRepositoryWorktreeDir(repoRoot), getReviewWorktreeName(source));

/** @param {string} path */
const markUsed = (path) => {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // A checkout that cannot be stamped simply looks older than it is, which
    // costs one extra rebuild rather than correctness.
  }
};

/** @param {string} path */
const getLastUsed = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Drop a checkout and the administrative entry that points at it. `git worktree
 * remove` refuses a directory it no longer recognizes, so the filesystem
 * removal is what actually guarantees the space is reclaimed.
 *
 * @param {string} repoRoot
 * @param {string} path
 */
const removeReviewWorktree = async (repoRoot, path) => {
  await gitOrEmpty(repoRoot, ['worktree', 'remove', '--force', path]);
  try {
    rmSync(path, { force: true, recursive: true });
  } catch {
    // Leave the directory for the next sweep rather than failing the review.
  }
  await gitOrEmpty(repoRoot, ['worktree', 'prune']);
};

/**
 * Retire checkouts this repository is done with, so the store stays bounded
 * whether the reviewer works through many pull requests quickly or leaves one
 * behind for a fortnight.
 *
 * @param {string} repoRoot
 * @param {string} keepPath
 */
const pruneReviewWorktrees = async (repoRoot, keepPath) => {
  const directory = getRepositoryWorktreeDir(repoRoot);
  /** @type {Array<{lastUsed: number; path: string}>} */
  let entries = [];
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name))
      .filter((path) => path !== keepPath)
      .map((path) => ({ lastUsed: getLastUsed(path), path }));
  } catch {
    return;
  }

  const now = Date.now();
  const fresh = entries
    .filter((entry) => now - entry.lastUsed <= MAX_WORKTREE_AGE_MS)
    .sort((left, right) => right.lastUsed - left.lastUsed);
  const stale = [
    ...entries.filter((entry) => now - entry.lastUsed > MAX_WORKTREE_AGE_MS),
    // The checkout being kept counts against the cap.
    ...fresh.slice(Math.max(0, MAX_WORKTREES_PER_REPOSITORY - 1)),
  ];
  for (const entry of stale) {
    await removeReviewWorktree(repoRoot, entry.path);
  }
};

/** @param {string} repoRoot @param {string} revision */
const hasCommit = async (repoRoot, revision) =>
  (
    await gitOrEmpty(repoRoot, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])
  ).trim() !== '';

/**
 * The review already fetched the head when it loaded its file contents, so this
 * is the recovery path for a checkout requested against a stale local mirror.
 *
 * @param {string} repoRoot
 * @param {PullRequestReviewSource} source
 * @param {string} headSha
 */
const fetchPullRequestHead = async (repoRoot, source, headSha) => {
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  const remote = await selectPullRequestRemote(repoRoot, pullRequest, headSha);
  await git(repoRoot, [
    'fetch',
    '--no-tags',
    remote.name,
    `+refs/pull/${pullRequest.number}/head:refs/codiff/pull-requests/${pullRequest.number}/head`,
  ]);
};

/** @type {Map<string, Promise<string>>} */
const pending = new Map();

/**
 * Materialize a pull request's head commit on disk, so opening a file, revealing
 * it in the file manager, and jumping to a definition all land on the revision
 * under review rather than on whatever the reviewer happens to have checked out.
 *
 * The checkout is detached and disposable: nothing here is meant to be edited,
 * and a new push re-points it in place rather than accumulating a checkout per
 * revision.
 *
 * @param {string} repoRoot
 * @param {PullRequestReviewSource} source
 * @returns {Promise<string>}
 */
const createReviewWorktree = async (repoRoot, source) => {
  const headSha = source.headSha;
  if (!headSha) {
    throw new Error('The pull request has no resolved head commit.');
  }

  if (!(await hasCommit(repoRoot, headSha))) {
    await fetchPullRequestHead(repoRoot, source, headSha);
  }

  const path = getReviewWorktreePath(repoRoot, source);
  const registered =
    existsSync(path) &&
    (await gitOrEmpty(path, ['rev-parse', '--show-toplevel'])).trim().length > 0;

  if (registered) {
    const current = (await gitOrEmpty(path, ['rev-parse', 'HEAD'])).trim();
    if (current !== headSha) {
      // Discarding is safe and intended: this checkout exists only to be read,
      // and the revision it is pinned to is the whole point of it.
      await git(path, ['checkout', '--detach', '--force', headSha]);
    }
    markUsed(path);
    return path;
  }

  if (existsSync(path)) {
    // A directory git no longer recognizes, left behind by an interrupted
    // removal. `worktree add` refuses to write into it.
    rmSync(path, { force: true, recursive: true });
  }

  mkdirSync(getRepositoryWorktreeDir(repoRoot), { recursive: true });
  await gitOrEmpty(repoRoot, ['worktree', 'prune']);
  await git(repoRoot, ['worktree', 'add', '--detach', path, headSha]);
  markUsed(path);
  await pruneReviewWorktrees(repoRoot, path);
  return path;
};

/**
 * @param {string} repoRoot
 * @param {PullRequestReviewSource} source
 * @returns {Promise<string>}
 */
const ensureReviewWorktree = (repoRoot, source) => {
  const key = getReviewWorktreePath(repoRoot, source);
  const existing = pending.get(key);
  if (existing) {
    return existing;
  }

  // Opening several files at once must not race two `worktree add` calls onto
  // the same path.
  const promise = createReviewWorktree(repoRoot, source).finally(() => {
    if (pending.get(key) === promise) {
      pending.delete(key);
    }
  });
  pending.set(key, promise);
  return promise;
};

/**
 * The directory whose files match what the review is showing.
 *
 * Local sources are already looking at the working tree. A pull request is not:
 * its files come from a fetched ref, and resolving them against the working
 * tree silently opens a different revision of the file at the review's line
 * numbers. Returns `undefined` when the review's revision cannot be produced,
 * so callers can decline rather than open the wrong content.
 *
 * @param {string} repoRoot
 * @param {ReviewSource} [source]
 * @returns {Promise<string | undefined>}
 */
const resolveReviewContentRoot = async (repoRoot, source) => {
  if (source?.type !== 'pull-request' || source.provider === 'gitlab') {
    return repoRoot;
  }

  if (!source.headSha) {
    return undefined;
  }

  // Reviewing a pull request that is already checked out locally needs no
  // checkout of its own, and the reviewer's own files are the better target.
  const head = (await gitOrEmpty(repoRoot, ['rev-parse', 'HEAD'])).trim();
  if (head === source.headSha) {
    const status = await gitOrEmpty(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
    if (status.trim() === '') {
      return repoRoot;
    }
  }

  try {
    return await ensureReviewWorktree(repoRoot, source);
  } catch {
    return undefined;
  }
};

module.exports = {
  MAX_WORKTREES_PER_REPOSITORY,
  MAX_WORKTREE_AGE_MS,
  ensureReviewWorktree,
  getRepositoryWorktreeDir,
  getReviewWorktreePath,
  pruneReviewWorktrees,
  resolveReviewContentRoot,
};
