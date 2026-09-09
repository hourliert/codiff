import type { FileTreeRowDecorationRenderer } from '@pierre/trees';
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react';
import { formatTreeLineCount, getDiffLineCount, getDiffLineCountTitle } from '../../lib/diff.ts';
import { fileTreeSort, statusForTree } from '../../lib/files.ts';
import type { ChangedFile } from '../../types.ts';

const emptyPaths = new Set<string>();
const emptyViewed: Readonly<Record<string, string>> = {};
const reloadDeltaGitStatusStyleAttribute = 'data-codiff-reload-delta-git-status';
const viewedRowStyleAttribute = 'data-codiff-viewed-rows';
const changedSinceStyleAttribute = 'data-codiff-changed-since-rows';

export function ReviewFileTree({
  changedSincePaths = emptyPaths,
  files,
  onActivatePath,
  reloadDeltaPaths = emptyPaths,
  scrollSelectedPathIntoView = false,
  selectedPath,
  showWhitespace,
  viewed = emptyViewed,
}: {
  /** Files the agent has touched since the last review round of this change. */
  changedSincePaths?: ReadonlySet<string>;
  files: ReadonlyArray<ChangedFile>;
  onActivatePath: (path: string) => void;
  reloadDeltaPaths?: ReadonlySet<string>;
  scrollSelectedPathIntoView?: boolean;
  selectedPath: string | null;
  showWhitespace: boolean;
  viewed?: Readonly<Record<string, string>>;
}) {
  const treeHostRef = useRef<HTMLDivElement>(null);
  const [hideViewed, setHideViewed] = useState(false);
  const [onlyChangedSince, setOnlyChangedSince] = useState(false);
  const changedSinceCount = useMemo(
    () => files.filter((file) => changedSincePaths.has(file.path)).length,
    [changedSincePaths, files],
  );
  const viewedCount = useMemo(
    () => files.filter((file) => viewed[file.path] === file.fingerprint).length,
    [files, viewed],
  );
  // The selected file stays listed even once it is viewed, so marking the file
  // you are reading does not make it vanish from under you.
  const visibleFiles = useMemo(() => {
    let visible = files;
    if (onlyChangedSince) {
      visible = visible.filter(
        (file) => changedSincePaths.has(file.path) || file.path === selectedPath,
      );
    }
    return hideViewed
      ? visible.filter(
          (file) => viewed[file.path] !== file.fingerprint || file.path === selectedPath,
        )
      : visible;
  }, [changedSincePaths, files, hideViewed, onlyChangedSince, selectedPath, viewed]);
  const paths = useMemo(() => visibleFiles.map((file) => file.path), [visibleFiles]);
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const lineCountsByPath = useMemo(
    () => new Map(visibleFiles.map((file) => [file.path, getDiffLineCount(file, showWhitespace)])),
    [showWhitespace, visibleFiles],
  );
  const lineCountsByPathRef = useRef(lineCountsByPath);
  const reloadDeltaGitStatusCSS = useMemo(
    () => getReloadDeltaGitStatusCSS(reloadDeltaPaths),
    [reloadDeltaPaths],
  );
  const viewedRowCSS = useMemo(() => getViewedRowCSS(visibleFiles, viewed), [viewed, visibleFiles]);
  const changedSinceCSS = useMemo(
    () => getChangedSinceCSS(visibleFiles, changedSincePaths),
    [changedSincePaths, visibleFiles],
  );
  const renderTreeRowDecoration = useCallback<FileTreeRowDecorationRenderer>(({ item }) => {
    const lineCount = lineCountsByPathRef.current.get(item.path);
    return lineCount?.countable
      ? {
          text: formatTreeLineCount(lineCount),
          title: getDiffLineCountTitle(lineCount),
        }
      : null;
  }, []);
  const status = useMemo(
    () =>
      visibleFiles.map((file) => ({
        path: file.path,
        status: statusForTree[file.status],
      })),
    [visibleFiles],
  );
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus: status,
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: 30,
    paths,
    renderRowDecoration: renderTreeRowDecoration,
    sort: fileTreeSort,
    unsafeCSS: `
      :host {
        --trees-bg-override: transparent;
        --trees-bg-muted-override: var(--hover-wash);
        --trees-border-color-override: var(--sidebar-border);
        --trees-fg-muted-override: var(--muted);
        --trees-fg-override: var(--sidebar-text);
        --trees-focus-ring-color-override: var(--tree-selection-focus);
        --trees-padding-inline-override: 4px;
        --trees-search-bg-override: rgb(127 127 127 / 0.1);
        --trees-search-fg-override: var(--sidebar-text);
        --trees-selected-bg-override: color-mix(in srgb, var(--tree-selection-bg) 46%, transparent);
        --trees-selected-fg-override: var(--sidebar-text);
        --trees-selected-focused-border-color-override: color-mix(in srgb, var(--tree-selection-focus) 42%, transparent);
        --truncate-marker-background-color: transparent;
        color-scheme: var(--codiff-tree-color-scheme, light dark);
        color: var(--sidebar-text);
        font: 13px/1.35 var(--font-sans);
      }

      button[data-type='item'] {
        background-color: transparent;
        border-radius: 14px;
        corner-shape: squircle;
      }

      [data-item-section='decoration'] {
        color: var(--muted);
        font: 600 10px/1 var(--font-mono);
        letter-spacing: 0;
      }
    `,
  });

  useTreeShadowStyle(treeHostRef, reloadDeltaGitStatusStyleAttribute, reloadDeltaGitStatusCSS);
  useTreeShadowStyle(treeHostRef, viewedRowStyleAttribute, viewedRowCSS);
  useTreeShadowStyle(treeHostRef, changedSinceStyleAttribute, changedSinceCSS);

  useLayoutEffect(() => {
    lineCountsByPathRef.current = lineCountsByPath;
    if (model.getFileTreeContainer()) {
      model.render({});
    }
  }, [lineCountsByPath, model]);

  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    model.setGitStatus(status);
  }, [model, status]);

  const scrollPathIntoView = useCallback(
    (path: string) => {
      model.focusPath(path);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const host = treeHostRef.current?.querySelector('file-tree-container');
          const row = Array.from(
            host?.shadowRoot?.querySelectorAll<HTMLElement>('[data-item-path]') ?? [],
          ).find((element) => element.getAttribute('data-item-path') === path);
          row?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });
        });
      });
    },
    [model],
  );

  useEffect(() => {
    if (!selectedPath) {
      return;
    }

    const selectedPaths = model.getSelectedPaths();
    if (selectedPaths.length === 1 && selectedPaths[0] === selectedPath) {
      return;
    }

    for (const path of selectedPaths) {
      model.getItem(path)?.deselect();
    }
    model.getItem(selectedPath)?.select();
    if (scrollSelectedPathIntoView) {
      requestAnimationFrame(() => scrollPathIntoView(selectedPath));
    }
  }, [model, scrollPathIntoView, scrollSelectedPathIntoView, selectedPath]);

  const handleTreeClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      for (const target of event.nativeEvent.composedPath()) {
        if (!('getAttribute' in target) || typeof target.getAttribute !== 'function') {
          continue;
        }

        const path = target.getAttribute('data-item-path');
        if (path && filePathSet.has(path)) {
          onActivatePath(path);
          return;
        }
      }
    },
    [filePathSet, onActivatePath],
  );

  return (
    <div className="file-tree-shell" ref={treeHostRef}>
      {changedSinceCount > 0 ? (
        <button
          aria-pressed={onlyChangedSince}
          className={`file-tree-viewed-filter${onlyChangedSince ? ' active' : ''}`}
          onClick={() => setOnlyChangedSince((current) => !current)}
          type="button"
        >
          {onlyChangedSince
            ? `Showing what moved · ${changedSinceCount} changed`
            : `Show ${changedSinceCount} changed since last review`}
        </button>
      ) : null}
      {viewedCount > 0 ? (
        <button
          aria-pressed={hideViewed}
          className={`file-tree-viewed-filter${hideViewed ? ' active' : ''}`}
          onClick={() => setHideViewed((current) => !current)}
          type="button"
        >
          {hideViewed
            ? `Showing what is left · ${viewedCount} viewed hidden`
            : `Hide ${viewedCount} viewed`}
        </button>
      ) : null}
      <PierreFileTree className="file-tree" model={model} onClick={handleTreeClick} />
    </div>
  );
}

const escapeCSSString = (value: string) =>
  value
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('\n', String.raw`\a `)
    .replaceAll('\r', String.raw`\d `)
    .replaceAll('\f', String.raw`\c `)
    .replaceAll('"', String.raw`\"`);

const getReloadDeltaGitStatusCSS = (paths: ReadonlySet<string>) =>
  [...paths]
    .map(
      (path) => `
        [data-item-path="${escapeCSSString(path)}"][data-item-git-status] > [data-item-section='git'] {
          color: var(--sidebar-ref);
        }
      `,
    )
    .join('\n');

/**
 * Marks the files the agent rewrote since the reviewer last looked, so a round
 * that only touched four of eighty files says so before anything is opened.
 */
const getChangedSinceCSS = (
  files: ReadonlyArray<ChangedFile>,
  changedSincePaths: ReadonlySet<string>,
) =>
  files
    .filter((file) => changedSincePaths.has(file.path))
    .map(
      (file) => `
        [data-item-path="${escapeCSSString(file.path)}"] > [data-item-section='name'] {
          color: var(--sidebar-ref);
          font-weight: 600;
        }
      `,
    )
    .join('\n');

const getViewedRowCSS = (
  files: ReadonlyArray<ChangedFile>,
  viewed: Readonly<Record<string, string>>,
) =>
  getViewedRowCSSFromSelectors(
    files
      .filter((file) => viewed[file.path] === file.fingerprint)
      .map((file) => `[data-item-path="${escapeCSSString(file.path)}"]`),
  );

const getViewedRowCSSFromSelectors = (selectors: ReadonlyArray<string>) => {
  if (selectors.length === 0) {
    return '';
  }

  const rowContent = selectors
    .flatMap((selector) => [
      `${selector} > [data-item-section='icon']`,
      `${selector} > [data-item-section='icon'] > :where(:not([data-icon-name='file-tree-icon-chevron']))`,
      `${selector} > [data-item-section='content']`,
      `${selector} > [data-item-section='decoration']`,
      `${selector} > [data-item-section='git']`,
    ])
    .join(',\n');

  return `
    ${rowContent} {
      color: var(--muted);
    }
  `;
};

const useTreeShadowStyle = (
  treeHostRef: RefObject<HTMLElement | null>,
  styleAttribute: string,
  css: string,
) => {
  useEffect(() => {
    // Tree unsafeCSS is constructor-time; keep dynamic row styling in a shadow style tag.
    if (syncTreeShadowStyle(treeHostRef.current, styleAttribute, css)) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      syncTreeShadowStyle(treeHostRef.current, styleAttribute, css);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [css, styleAttribute, treeHostRef]);
};

const syncTreeShadowStyle = (treeHost: HTMLElement | null, styleAttribute: string, css: string) => {
  const shadowRoot = treeHost?.querySelector('file-tree-container')?.shadowRoot;
  if (!shadowRoot) {
    return false;
  }

  const existingStyle = shadowRoot.querySelector<HTMLStyleElement>(`style[${styleAttribute}]`);
  if (css.length === 0) {
    existingStyle?.remove();
    return true;
  }

  const style = existingStyle ?? document.createElement('style');
  style.setAttribute(styleAttribute, '');
  style.textContent = css;
  if (!existingStyle) {
    shadowRoot.append(style);
  }
  return true;
};
