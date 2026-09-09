import { useEffect, useState } from 'react';
import type { WalkthroughProgressEvent, WalkthroughProgressPhase } from '../../../types.ts';

export const walkthroughResponseLabels = [
  'Building walkthrough…',
  'Composing walkthrough…',
  'Writing walkthrough…',
  'Assembling walkthrough…',
  'Creating walkthrough…',
  'Producing walkthrough…',
] as const;

export const nextWalkthroughResponseLabelIndex = (current: number) =>
  (current + 1) % walkthroughResponseLabels.length;

export type WalkthroughProgressState = Omit<WalkthroughProgressEvent, 'phase'> & {
  phase: WalkthroughProgressPhase | null;
  responseLabelIndex: number;
  stageRevision: number;
  updatedAt: number;
};

export const initialWalkthroughProgress: WalkthroughProgressState = {
  chapters: 0,
  deltas: 0,
  outputCharacters: 0,
  phase: null,
  responseLabelIndex: -1,
  stageRevision: 0,
  stops: 0,
  thinkingCharacters: 0,
  updatedAt: 0,
};

const TIMER_THRESHOLD_SECONDS = 3;

/**
 * How long without a delta before the display stops claiming activity. Long
 * enough to ride out an ordinary gap between tokens, short enough that a stall
 * is visible while the reviewer is still looking at it.
 */
const IDLE_THRESHOLD_MS = 2500;

/** When a gap stops being a pause and is worth naming. */
const STALLED_THRESHOLD_MS = 20_000;

const formatCount = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);

const formatPlural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * What the agent has produced so far.
 *
 * The volume leads and the structures are appended to it, rather than replacing
 * it once they appear. Structures are the better measure -- they have a
 * denominator a reviewer can feel -- but they arrive only once the response
 * reaches them, and swapping one reading for the other left the line unchanged
 * for whatever stretch came first. Appending keeps a number moving throughout,
 * whatever order the agent writes its fields in.
 */
const getDetail = ({
  chapters,
  outputCharacters,
  stops,
  thinkingCharacters,
}: WalkthroughProgressState) => {
  const parts = [];
  if (outputCharacters > 0) {
    parts.push(`${formatCount(outputCharacters)} written`);
  } else if (thinkingCharacters > 0) {
    // Only until the response starts. After that, what was written is the
    // number that says how far along this is.
    parts.push(`${formatCount(thinkingCharacters)} reasoned`);
  }
  if (chapters > 0) {
    parts.push(formatPlural(chapters, 'chapter'));
  }
  if (stops > 0) {
    parts.push(formatPlural(stops, 'stop'));
  }
  return parts.join(' · ');
};

export function WalkthroughProgress({
  phase,
  progress,
  responseLabelIndex,
  stageRevision,
}: {
  phase: WalkthroughProgressPhase | null;
  progress?: WalkthroughProgressState;
  responseLabelIndex: number;
  stageRevision: number;
}) {
  // Left at zero rather than read from the clock, which render may not do. The
  // first tick fills it in, and until then nothing has had time to go quiet.
  const [timerState, setTimerState] = useState({
    elapsedSeconds: 0,
    now: 0,
    stageRevision,
  });

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTimerState({
        elapsedSeconds: Math.floor((now - startedAt) / 1000),
        now,
        stageRevision,
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [stageRevision]);

  const elapsedSeconds = timerState.stageRevision === stageRevision ? timerState.elapsedSeconds : 0;
  const showTimer = elapsedSeconds >= TIMER_THRESHOLD_SECONDS;
  const label =
    phase === 'preparing-files'
      ? 'Preparing files…'
      : phase === 'agent-generation'
        ? 'Analyzing changes…'
        : phase === 'response-received'
          ? walkthroughResponseLabels[
              Math.abs(responseLabelIndex) % walkthroughResponseLabels.length
            ]
          : 'Generating walkthrough…';

  // Before the first event there is nothing to be idle about: the run has not
  // reported anything yet, which is not the same as having gone quiet.
  const silentMs = progress?.updatedAt && timerState.now ? timerState.now - progress.updatedAt : 0;
  const idle = silentMs >= IDLE_THRESHOLD_MS;
  const detail = progress
    ? silentMs >= STALLED_THRESHOLD_MS
      ? `no output for ${Math.floor(silentMs / 1000)}s`
      : getDetail(progress)
    : '';

  return (
    <span aria-live="polite" className={`walkthrough-progress${idle ? ' idle' : ''}`} role="status">
      <span className="walkthrough-progress-line">
        <span className="walkthrough-progress-label">{label}</span>
        <span
          aria-hidden={!showTimer}
          className={`walkthrough-progress-timer${showTimer ? ' visible' : ''}`}
        >
          {showTimer ? `${elapsedSeconds}s` : '0s'}
        </span>
      </span>
      {detail ? <span className="walkthrough-progress-detail">{detail}</span> : null}
    </span>
  );
}
