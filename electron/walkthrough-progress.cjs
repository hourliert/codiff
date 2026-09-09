// @ts-check

/**
 * Agent deltas arrive per token, which is far more often than a person can
 * read. Coalesce them onto a fixed cadence so the renderer sees movement
 * without the IPC channel carrying one message per token.
 */
const PROGRESS_INTERVAL_MS = 150;

/**
 * Chapters and stops are counted from marker keys rather than by parsing,
 * because the response is only ever a valid *prefix* of JSON while it streams.
 * Both markers are unique to their level in the walkthrough schema: `icon`
 * appears once per chapter, `importance` once per stop. Counting a key that
 * repeats across levels — `title`, `hunkIds` — would conflate them.
 */
const CHAPTER_MARKER = /"icon"\s*:/gu;
const STOP_MARKER = /"importance"\s*:/gu;

/** @param {string} text @param {RegExp} marker */
const countMarkers = (text, marker) => {
  marker.lastIndex = 0;
  let count = 0;
  while (marker.exec(text) !== null) {
    count += 1;
  }
  return count;
};

/**
 * Report walkthrough progress to a window.
 *
 * The returned function takes the phase and, for streaming backends, the text
 * of the delta that triggered it. The text is measured and counted here and
 * then dropped: only totals are sent, so no model output leaves this process.
 *
 * @param {Pick<Electron.WebContents, 'isDestroyed' | 'send'>} webContents
 * @param {() => boolean} [isCurrent]
 */
const createWalkthroughProgressReporter = (webContents, isCurrent = () => true) => {
  /** @type {import('../core/types.ts').WalkthroughProgressPhase | null} */
  let phase = null;
  let chapters = 0;
  let deltas = 0;
  let outputCharacters = 0;
  let response = '';
  let stops = 0;
  let thinkingCharacters = 0;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  const send = () => {
    timer = null;
    if (phase === null || webContents.isDestroyed() || !isCurrent()) {
      return;
    }

    // Counted over the whole response rather than per delta: a marker key is
    // routinely split across two deltas, and only the joined text contains it.
    chapters = countMarkers(response, CHAPTER_MARKER);
    stops = countMarkers(response, STOP_MARKER);

    /** @type {import('../core/types.ts').WalkthroughProgressEvent} */
    const progress = { chapters, deltas, outputCharacters, phase, stops, thinkingCharacters };
    webContents.send('codiff:walkthroughProgress', progress);
  };

  /**
   * @param {import('../core/types.ts').WalkthroughProgressPhase} nextPhase
   * @param {string} [delta]
   */
  return (nextPhase, delta) => {
    deltas += 1;
    if (typeof delta === 'string' && delta.length > 0) {
      if (nextPhase === 'agent-generation') {
        thinkingCharacters += delta.length;
      } else {
        outputCharacters += delta.length;
        response += delta;
      }
    }

    // A phase change is the one thing a reviewer reads as a step forward, so it
    // is never held back by the cadence.
    if (nextPhase !== phase) {
      phase = nextPhase;
      if (timer) {
        clearTimeout(timer);
      }
      send();
      return;
    }

    if (!timer) {
      timer = setTimeout(send, PROGRESS_INTERVAL_MS);
      // Progress must never be the reason the process stays alive.
      timer.unref?.();
    }
  };
};

module.exports = { createWalkthroughProgressReporter };
