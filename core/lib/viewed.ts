import type { ChangedFile, ReviewSource } from '../types.ts';
import { getWalkthroughReviewKeyPrefix } from './review-identity.ts';
import { getSourceKey } from './source.ts';

/**
 * Local sources have one review per repository, so their state stays on the
 * repository root and keeps the key it has always had. A repository has many
 * pull requests open at once, so those scope the key to the review as well.
 */
const getViewedKey = (root: string, source?: ReviewSource) =>
  source && source.type === 'pull-request'
    ? `codiff:viewed:${root}:${getSourceKey(source)}`
    : `codiff:viewed:${root}`;

export const readViewed = (root: string, source?: ReviewSource): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(getViewedKey(root, source)) || '{}') as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
};

export const writeViewed = (
  root: string,
  viewed: Record<string, string>,
  source?: ReviewSource,
) => {
  localStorage.setItem(getViewedKey(root, source), JSON.stringify(viewed));
};

/**
 * Reconcile the locally cached viewed state with what the review host reports.
 *
 * The host is authoritative for whole files: it is the record that survives
 * across machines, and it keeps a file marked viewed when a later push left
 * that file alone — something the local cache cannot do, because every file's
 * fingerprint carries the head SHA and so turns over on any new commit.
 *
 * The local cache is authoritative for Codiff's per-block marks, which the host
 * has no representation for. Those only survive on files the host does not
 * already call viewed, since a whole-file mark supersedes them.
 */
export const mergeHostViewed = (
  files: ReadonlyArray<ChangedFile>,
  local: Readonly<Record<string, string>>,
  viewedPaths?: ReadonlyArray<string>,
): Record<string, string> => {
  if (!viewedPaths) {
    return { ...local };
  }

  const hostViewed = new Set(viewedPaths);
  const next: Record<string, string> = {};
  for (const file of files) {
    if (hostViewed.has(file.path)) {
      next[file.path] = file.fingerprint;
      continue;
    }

    const prefix = getWalkthroughReviewKeyPrefix(file.path);
    for (const [key, fingerprint] of Object.entries(local)) {
      if (key.startsWith(prefix)) {
        next[key] = fingerprint;
      }
    }
  }
  return next;
};

/**
 * The whole-file viewed transitions between two states, which are the only part
 * of Codiff's viewed state the host can represent.
 */
export const getViewedFileDelta = (
  files: ReadonlyArray<ChangedFile>,
  previous: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
): ReadonlyArray<{ path: string; viewed: boolean }> =>
  files
    .map((file) => ({
      path: file.path,
      viewed: next[file.path] === file.fingerprint,
      wasViewed: previous[file.path] === file.fingerprint,
    }))
    .filter(({ viewed, wasViewed }) => viewed !== wasViewed)
    .map(({ path, viewed }) => ({ path, viewed }));
