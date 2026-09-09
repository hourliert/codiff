import type { ReviewCommentAnchor, WalkthroughHunk } from '../types.ts';

/**
 * What a walkthrough stop looks like against the last round of the same review.
 *
 * Both readings are computed, never asserted by the agent: `changed` comes from
 * a git diff between the two heads, `settled` from GitHub's own record of which
 * conversations the reviewer closed and which ones the code moved out from
 * under. Neither is a claim about whether the stop still deserves attention --
 * they are the two facts a reviewer would otherwise have to reconstruct.
 */
export type StopContinuity = {
  changed: boolean;
  settled: number;
};

const containsLine = (hunk: WalkthroughHunk, lineNumber: number) =>
  (hunk.additionStart != null &&
    hunk.additionEnd != null &&
    lineNumber >= hunk.additionStart &&
    lineNumber <= hunk.additionEnd) ||
  (hunk.deletionStart != null &&
    hunk.deletionEnd != null &&
    lineNumber >= hunk.deletionStart &&
    lineNumber <= hunk.deletionEnd);

export const getStopContinuity = (
  hunks: ReadonlyArray<WalkthroughHunk>,
  changedSincePaths: ReadonlySet<string>,
  settledAnchors: ReadonlyArray<ReviewCommentAnchor>,
): StopContinuity => {
  let settled = 0;
  for (const anchor of settledAnchors) {
    if (
      hunks.some((hunk) => hunk.path === anchor.filePath && containsLine(hunk, anchor.lineNumber))
    ) {
      settled++;
    }
  }
  return {
    changed: hunks.some((hunk) => changedSincePaths.has(hunk.path)),
    settled,
  };
};

export const formatStopContinuity = ({ changed, settled }: StopContinuity) => {
  const parts = [];
  if (changed) {
    parts.push('changed since last review');
  }
  if (settled > 0) {
    parts.push(`${settled} settled`);
  }
  return parts.join(' · ');
};
