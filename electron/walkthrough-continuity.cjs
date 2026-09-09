// @ts-check

const { gitOrEmpty } = require('./git-state/common.cjs');

/** @typedef {import('../core/types.ts').WalkthroughPreviousRound} WalkthroughPreviousRound */

/**
 * What the agent changed between the head a previous review round looked at and
 * the head under review now.
 *
 * A plain two-dot diff, because the question is "how does this differ from what
 * I already read", not "what landed on this branch" -- if the base moved under
 * the pull request, that moved for the reviewer too.
 *
 * The previous head can be gone: an agent force-pushing replaces it, and once
 * nothing references it locally it is collectable. `gitOrEmpty` turns that into
 * no signal rather than a failed walkthrough, which is the right trade -- this
 * decorates a review, it does not gate one.
 *
 * @param {string} repoRoot
 * @param {string | undefined} previousHeadSha
 * @param {string | undefined} headSha
 * @returns {Promise<ReadonlyArray<string>>}
 */
const readPathsChangedSince = async (repoRoot, previousHeadSha, headSha) => {
  if (!previousHeadSha || !headSha || previousHeadSha === headSha) {
    return [];
  }
  const output = await gitOrEmpty(repoRoot, [
    'diff',
    '--name-only',
    `${previousHeadSha}..${headSha}`,
  ]);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};

/**
 * @param {string} repoRoot
 * @param {import('../core/types.ts').ReviewSource} source
 * @param {{headSha?: string; writtenAt: number} | null | undefined} previousRecord
 * @returns {Promise<WalkthroughPreviousRound | undefined>}
 */
const readPreviousRound = async (repoRoot, source, previousRecord) => {
  const previousHeadSha = previousRecord?.headSha;
  if (source.type !== 'pull-request' || !previousHeadSha || previousHeadSha === source.headSha) {
    return undefined;
  }
  const changedPaths = await readPathsChangedSince(repoRoot, previousHeadSha, source.headSha);
  // A round nobody can compare against is not worth announcing.
  return changedPaths.length
    ? { changedPaths, headSha: previousHeadSha, reviewedAt: previousRecord.writtenAt }
    : undefined;
};

module.exports = {
  readPathsChangedSince,
  readPreviousRound,
};
