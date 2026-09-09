/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { ReviewFileTree } from '../app/components/FileTree.tsx';
import { createChangedFile } from './helpers/fixtures.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

test('review file trees share selection, activation, decorations, and row styling', async () => {
  const firstFile = createChangedFile('src/first.ts', {
    fingerprint: 'first-current',
  });
  const secondFile = createChangedFile('src/second.ts', { status: 'added' });
  const onActivatePath = vi.fn();
  await using view = await renderReact(
    <ReviewFileTree
      files={[firstFile, secondFile]}
      onActivatePath={onActivatePath}
      reloadDeltaPaths={new Set([secondFile.path])}
      selectedPath={firstFile.path}
      showWhitespace={false}
      viewed={{ [firstFile.path]: firstFile.fingerprint }}
    />,
  );

  await waitFor(() => {
    const shadowRoot = view.container.querySelector('file-tree-container')?.shadowRoot;
    expect(shadowRoot?.querySelector(`[data-item-path="${firstFile.path}"]`)).not.toBeNull();
    expect(shadowRoot?.querySelector(`[data-item-path="${secondFile.path}"]`)).not.toBeNull();
  });
  const shadowRoot = view.container.querySelector('file-tree-container')?.shadowRoot;
  expect(shadowRoot).not.toBeNull();
  const firstRow = shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${firstFile.path}"]`);
  const secondRow = shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${secondFile.path}"]`);
  expect(firstRow?.hasAttribute('data-item-selected')).toBe(true);
  expect(firstRow?.querySelector("[data-item-section='decoration']")?.textContent).not.toBe('');
  expect(shadowRoot?.querySelector('style[data-codiff-viewed-rows]')?.textContent).toContain(
    `[data-item-path="${firstFile.path}"]`,
  );
  expect(
    shadowRoot?.querySelector('style[data-codiff-reload-delta-git-status]')?.textContent,
  ).toContain(`[data-item-path="${secondFile.path}"][data-item-git-status]`);
  await act(async () => secondRow?.click());
  expect(onActivatePath).toHaveBeenCalledWith(secondFile.path);
  await view.rerender(
    <ReviewFileTree
      files={[firstFile, secondFile]}
      onActivatePath={onActivatePath}
      selectedPath={secondFile.path}
      showWhitespace={false}
    />,
  );
  await waitFor(() => {
    expect(
      shadowRoot
        ?.querySelector(`[data-item-path="${secondFile.path}"]`)
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });
});

test('the file tree can show only what changed since the last review round', async () => {
  const movedFile = createChangedFile('src/moved.ts');
  const settledFile = createChangedFile('src/settled.ts');
  await using view = await renderReact(
    <ReviewFileTree
      changedSincePaths={new Set([movedFile.path])}
      files={[movedFile, settledFile]}
      onActivatePath={vi.fn()}
      selectedPath={null}
      showWhitespace={false}
    />,
  );

  await waitFor(() => {
    expect(
      view.container.querySelector<HTMLButtonElement>('.file-tree-viewed-filter')?.textContent,
    ).toBe('Show 1 changed since last review');
  });
  // Marked before anything is filtered, so a round that touched one of eighty
  // files says so without the reviewer opening a thing.
  const shadowRoot = view.container.querySelector('file-tree-container')?.shadowRoot;
  expect(shadowRoot?.querySelector('style[data-codiff-changed-since-rows]')?.textContent).toContain(
    `[data-item-path="${movedFile.path}"]`,
  );

  await act(async () =>
    view.container.querySelector<HTMLButtonElement>('.file-tree-viewed-filter')?.click(),
  );
  await waitFor(() => {
    expect(
      view.container.querySelector<HTMLButtonElement>('.file-tree-viewed-filter')?.textContent,
    ).toBe('Showing what moved · 1 changed');
    const rows = view.container.querySelector('file-tree-container')?.shadowRoot;
    expect(rows?.querySelector(`[data-item-path="${settledFile.path}"]`)).toBeNull();
    expect(rows?.querySelector(`[data-item-path="${movedFile.path}"]`)).not.toBeNull();
  });
});

test('the file tree offers no round filter when nothing moved', async () => {
  await using view = await renderReact(
    <ReviewFileTree
      files={[createChangedFile('src/only.ts')]}
      onActivatePath={vi.fn()}
      selectedPath={null}
      showWhitespace={false}
    />,
  );

  await waitFor(() => {
    expect(view.container.querySelector('file-tree-container')).not.toBeNull();
  });
  expect(view.container.querySelector('.file-tree-viewed-filter')).toBeNull();
});
