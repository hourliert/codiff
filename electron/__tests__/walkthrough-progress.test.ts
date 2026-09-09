import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';
import type { WalkthroughProgressEvent } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { createWalkthroughProgressReporter } = require('../walkthrough-progress.cjs') as {
  createWalkthroughProgressReporter: (
    webContents: {
      isDestroyed: () => boolean;
      send: (channel: string, progress: WalkthroughProgressEvent) => void;
    },
    isCurrent?: () => boolean,
  ) => (phase: WalkthroughProgressEvent['phase'], delta?: string) => void;
};

const lastProgress = (send: ReturnType<typeof vi.fn>): WalkthroughProgressEvent =>
  send.mock.calls.at(-1)?.[1];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('reports a phase change immediately and coalesces the deltas that follow', async () => {
  const send = vi.fn();
  const reportProgress = createWalkthroughProgressReporter({
    isDestroyed: () => false,
    send,
  });

  reportProgress('agent-generation', 'think');
  expect(send).toHaveBeenCalledTimes(1);
  expect(lastProgress(send)).toMatchObject({ phase: 'agent-generation', thinkingCharacters: 5 });

  // Deltas within one interval are one message, so token-rate output does not
  // become IPC-rate traffic.
  reportProgress('agent-generation', 'ing');
  reportProgress('agent-generation', ' more');
  expect(send).toHaveBeenCalledTimes(1);

  await sleep(220);
  expect(send).toHaveBeenCalledTimes(2);
  expect(lastProgress(send)).toMatchObject({ deltas: 3, thinkingCharacters: 13 });

  // A phase change is what a reviewer reads as a step, so it is never held.
  reportProgress('response-received', '{"a": 1}');
  expect(send).toHaveBeenCalledTimes(3);
  expect(lastProgress(send)).toMatchObject({
    outputCharacters: 8,
    phase: 'response-received',
    thinkingCharacters: 13,
  });
});

test('counts walkthrough structures across the deltas that split them', async () => {
  const send = vi.fn();
  const reportProgress = createWalkthroughProgressReporter({
    isDestroyed: () => false,
    send,
  });

  reportProgress('response-received', '{"chapters": [{"id": "a", "ic');
  // The marker key is split down the middle: counting each delta on its own
  // would never see it.
  reportProgress('response-received', 'on": "x", "stops": [{"importance": "critical"},');
  reportProgress('response-received', '{"importance": "normal"}]}]}');

  await sleep(220);
  expect(lastProgress(send)).toMatchObject({ chapters: 1, stops: 2 });
});

test('stays quiet once the window is gone or the request is superseded', async () => {
  let current = true;
  let destroyed = false;
  const send = vi.fn();
  const reportProgress = createWalkthroughProgressReporter(
    { isDestroyed: () => destroyed, send },
    () => current,
  );

  destroyed = true;
  reportProgress('agent-generation', 'a');
  expect(send).not.toHaveBeenCalled();

  destroyed = false;
  current = false;
  reportProgress('response-received', 'b');
  await sleep(220);
  expect(send).not.toHaveBeenCalled();
});
