import { CheckIcon as Check } from '@phosphor-icons/react/Check';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/GitBranch';
import { PathIcon as Path } from '@phosphor-icons/react/Path';
import { ShareNetworkIcon as ShareNetwork } from '@phosphor-icons/react/ShareNetwork';
import { useMemo } from 'react';
import { renderInlineMarkdown } from '../../../lib/markdown.tsx';
import {
  buildCommitModel,
  formatWalkthroughFileLineRows,
  getUncoveredWalkthroughFileLineItems,
  getWalkthroughChapterWeights,
  isWalkthroughCommittable,
  isWalkthroughStopViewed,
  isWalkthroughSupportViewed,
  walkthroughItemTitleFallback,
  type WalkthroughView,
  type WalkthroughStopView,
} from '../../../lib/narrative-walkthrough.ts';
import type { StopContinuity } from '../../../lib/walkthrough-continuity.ts';
import { formatStopContinuity, getStopContinuity } from '../../../lib/walkthrough-continuity.ts';
import type { ChangedFile, NarrativeWalkthrough, ReviewCommentAnchor } from '../../../types.ts';
import { ChapterIcon } from './parts.tsx';
import type { NarrativeNavigation } from './useNarrativeNavigation.ts';

function TocFileRows({
  files,
}: {
  files: ReadonlyArray<{
    added: number;
    deleted: number;
    label: string;
    path?: string;
    title: string;
  }>;
}) {
  return (
    <span className="wt-toc-file-list">
      {files.map((file, index) => (
        <span className="wt-toc-file-row" key={file.path ?? `${file.title}:${file.label}:${index}`}>
          <span className="wt-toc-file" title={file.title}>
            {file.label}
          </span>
          <span className="wt-toc-count">
            <span className="added">+{file.added}</span>
            {file.deleted > 0 ? <span className="deleted">−{file.deleted}</span> : null}
          </span>
        </span>
      ))}
    </span>
  );
}

const emptyPaths: ReadonlySet<string> = new Set();
const emptyAnchors: ReadonlyArray<ReviewCommentAnchor> = [];
const emptyViewed: Readonly<Record<string, string>> = {};

/** One line standing in for file rows the reviewer has already marked viewed. */
function TocFoldedFiles({ count }: { count: number }) {
  return (
    <span className="wt-toc-folded">
      {count} {count === 1 ? 'file' : 'files'} viewed
    </span>
  );
}

function TocStop({
  continuity,
  current,
  done,
  onSelect,
  stop,
}: {
  continuity: StopContinuity;
  current: boolean;
  /** Every file the stop covers is marked viewed. */
  done: boolean;
  onSelect: (index: number) => void;
  stop: WalkthroughStopView;
}) {
  // A finished stop folds its file rows, which is most of its height, so a long
  // walkthrough shrinks as it is reviewed. The current stop always lists its
  // files: selecting a folded stop is how its files are shown again.
  const isDone = done && !current;
  const files = formatWalkthroughFileLineRows(stop.hunks);
  const title = stop.title ?? walkthroughItemTitleFallback(stop);
  const continuityLabel = formatStopContinuity(continuity);
  return (
    <button
      className={`wt-toc-stop${current ? ' current' : ''}${isDone ? ' done' : ''}`}
      onClick={() => onSelect(stop.index)}
      title={title}
      type="button"
    >
      <span className="wt-toc-rail">
        {isDone ? (
          <span className="wt-toc-node done">
            <Check size={8} weight="bold" />
          </span>
        ) : (
          <span className={`wt-toc-node${current ? ' current' : ''}`}>
            {current ? <span className="wt-toc-node-pulse" /> : null}
          </span>
        )}
      </span>
      <span className="wt-toc-main">
        <span className="wt-toc-title-row">
          <span className="wt-toc-num">{stop.index + 1}</span>
          <span className="wt-toc-title">{title}</span>
        </span>
        {isDone ? <TocFoldedFiles count={files.length} /> : <TocFileRows files={files} />}
        {continuityLabel ? <span className="wt-toc-continuity">{continuityLabel}</span> : null}
      </span>
    </button>
  );
}

function SupportingFilesStop({
  files,
  navigation,
  showWhitespace,
  viewed,
  walkthroughView,
}: {
  files: ReadonlyArray<ChangedFile>;
  navigation: NarrativeNavigation;
  showWhitespace: boolean;
  viewed: Readonly<Record<string, string>>;
  walkthroughView: WalkthroughView;
}) {
  const uncoveredFiles = getUncoveredWalkthroughFileLineItems(
    files,
    walkthroughView,
    showWhitespace,
  );
  if (walkthroughView.support.length === 0 && uncoveredFiles.length === 0) {
    return null;
  }
  const current = navigation.mode === 'support';
  const isDone =
    !current && isWalkthroughSupportViewed(files, walkthroughView, viewed, showWhitespace);
  const fileRows = formatWalkthroughFileLineRows([
    ...walkthroughView.support.flatMap((item) => item.hunks),
    ...uncoveredFiles,
  ]);
  return (
    <div className="wt-toc-chapter">
      <div className="wt-toc-chapter-head">
        <span className="wt-toc-chapter-icon">
          <Path size={15} />
        </span>
        <span className="wt-toc-chapter-title">Support</span>
      </div>
      <div className="wt-toc-stops">
        <button
          className={`wt-toc-stop${current ? ' current' : ''}${isDone ? ' done' : ''}`}
          onClick={navigation.openSupport}
          title="Changed alongside the main walkthrough"
          type="button"
        >
          <span className="wt-toc-rail">
            {isDone ? (
              <span className="wt-toc-node done">
                <Check size={8} weight="bold" />
              </span>
            ) : (
              <span className={`wt-toc-node${current ? ' current' : ''}`}>
                {current ? <span className="wt-toc-node-pulse" /> : null}
              </span>
            )}
          </span>
          <span className="wt-toc-main">
            {isDone ? <TocFoldedFiles count={fileRows.length} /> : <TocFileRows files={fileRows} />}
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * The reading controls: how much of the walkthrough is on screen, and how many
 * of its stops are finished. A stop is finished when every file it covers is
 * marked viewed, which is the same rule its tick follows.
 */
function TocReadingBar({
  files,
  navigation,
  viewed,
}: {
  files: ReadonlyArray<ChangedFile>;
  navigation: NarrativeNavigation;
  viewed: Readonly<Record<string, string>>;
}) {
  const { importanceFilter, stopCounts, walkthroughView } = navigation;
  if (!walkthroughView) {
    return null;
  }

  const viewedStopCount = walkthroughView.sequence.filter((stop) =>
    isWalkthroughStopViewed(stop, files, viewed),
  ).length;
  // Nothing to choose between when every stop is critical, or none is.
  const canFilter = stopCounts.critical > 0 && stopCounts.critical < stopCounts.total;

  return (
    <div className="wt-toc-reading">
      <span className="wt-toc-progress">
        {viewedStopCount} of {walkthroughView.sequence.length} stops viewed
      </span>
      {canFilter ? (
        <span className="wt-toc-filter">
          <button
            aria-pressed={importanceFilter === 'all'}
            className={`wt-toc-filter-option${importanceFilter === 'all' ? ' active' : ''}`}
            onClick={() => navigation.setImportanceFilter('all')}
            type="button"
          >
            All {stopCounts.total}
          </button>
          <button
            aria-pressed={importanceFilter === 'critical'}
            className={`wt-toc-filter-option${importanceFilter === 'critical' ? ' active' : ''}`}
            onClick={() => navigation.setImportanceFilter('critical')}
            title="Read the stops the walkthrough marked critical first; the rest stay one click away."
            type="button"
          >
            Critical {stopCounts.critical}
          </button>
        </span>
      ) : null}
    </div>
  );
}

export function NarrativeSidebar({
  allowCommit = true,
  changedSincePaths = emptyPaths,
  files,
  navigation,
  onShareWalkthrough,
  settledCommentAnchors = emptyAnchors,
  shareWalkthroughDisabled = false,
  showWhitespace,
  viewed = emptyViewed,
  walkthrough,
}: {
  allowCommit?: boolean;
  changedSincePaths?: ReadonlySet<string>;
  files: ReadonlyArray<ChangedFile>;
  navigation: NarrativeNavigation;
  onShareWalkthrough?: () => void;
  settledCommentAnchors?: ReadonlyArray<ReviewCommentAnchor>;
  shareWalkthroughDisabled?: boolean;
  showWhitespace: boolean;
  viewed?: Readonly<Record<string, string>>;
  walkthrough: NarrativeWalkthrough;
}) {
  const chapterWeights = useMemo(() => getWalkthroughChapterWeights(walkthrough), [walkthrough]);
  const { walkthroughView } = navigation;
  if (!walkthroughView) {
    return <div className="wt-empty">This walkthrough has no readable sequence.</div>;
  }

  const currentStopId =
    navigation.mode === 'stop' ? walkthroughView.sequence[navigation.index]?.id : null;

  const committable = allowCommit && isWalkthroughCommittable(walkthrough);
  const commitModel = committable ? buildCommitModel(walkthroughView, files) : null;
  const commitFiles = commitModel
    ? formatWalkthroughFileLineRows(
        commitModel.files.filter((file) => navigation.commitSelected.has(file.path)),
      )
    : null;

  return (
    <div className="walkthrough-list">
      {walkthrough.thesis ? (
        <div className="wt-thesis">
          <span className="wt-focus-label">Does it do what it says</span>
          <p>{renderInlineMarkdown(walkthrough.thesis)}</p>
        </div>
      ) : null}
      <div className="wt-focus">
        <span className="wt-focus-label">Review focus</span>
        <p>{renderInlineMarkdown(walkthrough.focus)}</p>
      </div>

      <TocReadingBar files={files} navigation={navigation} viewed={viewed} />

      <div className="wt-toc-scroll">
        {walkthroughView.chapters.map((chapter) => {
          const weight = chapterWeights.get(chapter.id);
          return (
            <div className="wt-toc-chapter" key={chapter.id}>
              <div className="wt-toc-chapter-head">
                <span className="wt-toc-chapter-icon">
                  <ChapterIcon icon={chapter.icon} size={15} />
                </span>
                <span className="wt-toc-chapter-title">{chapter.title}</span>
                {weight != null && weight > 0 ? (
                  <span className="wt-toc-chapter-weight" title={`${weight}% of the changed lines`}>
                    {weight}%
                  </span>
                ) : null}
              </div>
              <div className="wt-toc-stops">
                {chapter.stops.map((stop) => (
                  <TocStop
                    continuity={getStopContinuity(
                      stop.hunks,
                      changedSincePaths,
                      settledCommentAnchors,
                    )}
                    current={navigation.mode === 'stop' && stop.id === currentStopId}
                    done={isWalkthroughStopViewed(stop, files, viewed)}
                    key={stop.id}
                    onSelect={navigation.goStop}
                    stop={stop}
                  />
                ))}
              </div>
            </div>
          );
        })}
        {walkthroughView.hiddenStopCount > 0 ? (
          <button
            className="wt-toc-hidden"
            onClick={() => navigation.setImportanceFilter('all')}
            type="button"
          >
            {walkthroughView.hiddenStopCount} more{' '}
            {walkthroughView.hiddenStopCount === 1 ? 'stop' : 'stops'} — show all
          </button>
        ) : null}
        <SupportingFilesStop
          files={files}
          navigation={navigation}
          showWhitespace={showWhitespace}
          viewed={viewed}
          walkthroughView={walkthroughView}
        />
        {committable && commitFiles ? (
          <div className="wt-toc-chapter">
            <div className="wt-toc-chapter-head">
              <span className="wt-toc-chapter-icon commit">
                <GitBranch size={15} />
              </span>
              <span className="wt-toc-chapter-title">Commit</span>
            </div>
            <div
              className={`wt-toc-stop wt-toc-stop-actions${
                navigation.mode === 'commit' ? ' current' : ''
              }`}
            >
              <span className="wt-toc-rail wt-toc-rail-commit">
                <span className={`wt-toc-node${navigation.mode === 'commit' ? ' current' : ''}`}>
                  {navigation.mode === 'commit' ? <span className="wt-toc-node-pulse" /> : null}
                </span>
              </span>
              <span className="wt-toc-main wt-toc-main-actions">
                <button
                  className="wt-toc-commit-action"
                  onClick={navigation.enterCommit}
                  type="button"
                >
                  <span className="wt-toc-title-row">
                    <span className="wt-toc-title">Write the commit</span>
                  </span>
                  <TocFileRows files={commitFiles} />
                </button>
              </span>
            </div>
          </div>
        ) : onShareWalkthrough ? (
          <div className="wt-toc-chapter">
            <div className="wt-toc-chapter-head">
              <span className="wt-toc-chapter-icon commit">
                <ShareNetwork size={15} />
              </span>
              <span className="wt-toc-chapter-title">Share</span>
            </div>
            <div className="wt-toc-stop wt-toc-stop-actions">
              <span className="wt-toc-rail wt-toc-rail-commit">
                <span className="wt-toc-node" />
              </span>
              <span className="wt-toc-main wt-toc-main-actions">
                <button
                  className="wt-toc-commit-action"
                  disabled={shareWalkthroughDisabled}
                  onClick={onShareWalkthrough}
                  type="button"
                >
                  <span className="wt-toc-title-row">
                    <span className="wt-toc-title">Share walkthrough</span>
                  </span>
                </button>
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
