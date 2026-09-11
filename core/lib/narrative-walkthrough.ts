import type {
  ChangedFile,
  DiffSection,
  NarrativeWalkthrough,
  WalkthroughChangeType,
  WalkthroughChapter,
  WalkthroughHunk,
  WalkthroughHunkGroup,
  WalkthroughIcon,
  WalkthroughSupportGroup,
  WalkthroughStop,
} from '../types.ts';
import { getDiffLineCount, getVisibleDiffSections } from './diff.ts';
import {
  filterPatchToHunkIds,
  getSectionWalkthroughHunks,
  isSyntheticWalkthroughHunk,
} from './narrative-walkthrough-diff.js';
import { getWalkthroughReviewIdentity, isReviewIdentityViewed } from './review-identity.ts';

type NarrativeLineCount = {
  added: number;
  deleted: number;
};

/** A stop with a global position in the walkthrough. */
export type WalkthroughStopView = WalkthroughStop & {
  chapterId: string;
  index: number;
};

/** A chapter with indexed stops. */
type WalkthroughChapterView = Omit<WalkthroughChapter, 'stops'> & {
  stops: ReadonlyArray<WalkthroughStopView>;
};

/** Support grouped by reason, preserving first-seen order. */
type WalkthroughSupportReason = {
  files: ReadonlyArray<WalkthroughSupportGroup>;
  reason: string;
};

/** Everything a narrative walkthrough needs to render. */
/**
 * Which stops the reviewer is currently reading. The model already grades every
 * stop; this is the reader's end of that grade, letting a long walkthrough be
 * taken as a short one first and in full afterwards.
 */
export type WalkthroughImportanceFilter = 'all' | 'critical';

export type WalkthroughView = {
  chapters: ReadonlyArray<WalkthroughChapterView>;
  /** Stops the current filter is holding back. They are hidden, never dropped. */
  hiddenStopCount: number;
  sequence: ReadonlyArray<WalkthroughStopView>;
  support: ReadonlyArray<WalkthroughSupportGroup>;
  supportByReason: ReadonlyArray<WalkthroughSupportReason>;
};

export type WalkthroughFileList = {
  label: string;
  title: string;
};

export type WalkthroughFileLineRow = {
  added: number;
  deleted: number;
  label: string;
  path?: string;
  title: string;
};

export const walkthroughFileName = (path: string): string => path.split('/').pop() ?? path;

const uniquePaths = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const unique: Array<string> = [];
  for (const path of paths) {
    if (!seen.has(path)) {
      seen.add(path);
      unique.push(path);
    }
  }
  return unique;
};

export const walkthroughItemPaths = (item: WalkthroughHunkGroup): ReadonlyArray<string> =>
  uniquePaths(item.hunks.map((hunk) => hunk.path));

const readableWalkthroughTitle = (value: string): string => {
  const normalized = value
    .replaceAll(/[`*_~]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
  const sentenceEnd = normalized.search(/[.!?](?:\s|$)/);
  const sentence = (sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd) : normalized).trim();
  if (sentence.length <= 80) {
    return sentence;
  }

  const prefix = sentence.slice(0, 77);
  const wordBoundary = prefix.lastIndexOf(' ');
  return `${prefix.slice(0, wordBoundary > 40 ? wordBoundary : 77).trimEnd()}...`;
};

export const walkthroughItemTitleFallback = (
  item: WalkthroughHunkGroup & { prose?: string },
): string =>
  item.title?.trim() ||
  (item.summary ? readableWalkthroughTitle(item.summary) : '') ||
  (item.prose ? readableWalkthroughTitle(item.prose) : '') ||
  walkthroughFileName(item.hunks[0]?.path ?? item.id);

export const formatWalkthroughFileList = (
  paths: ReadonlyArray<string>,
  maxVisibleFiles = 5,
): WalkthroughFileList => {
  const unique = uniquePaths(paths);
  const count = unique.length;
  return {
    label:
      count === 0
        ? '0 files'
        : count > maxVisibleFiles
          ? `${count} files`
          : unique.map(walkthroughFileName).join(', '),
    title: unique.join('\n'),
  };
};

export const formatWalkthroughFileLineRows = (
  items: ReadonlyArray<{ added: number; deleted: number; path: string }>,
  maxVisibleFiles = 5,
): ReadonlyArray<WalkthroughFileLineRow> => {
  const order: Array<string> = [];
  const totalsByPath = new Map<string, NarrativeLineCount>();
  for (const item of items) {
    if (!totalsByPath.has(item.path)) {
      order.push(item.path);
      totalsByPath.set(item.path, { added: 0, deleted: 0 });
    }
    const current = totalsByPath.get(item.path)!;
    totalsByPath.set(item.path, {
      added: current.added + item.added,
      deleted: current.deleted + item.deleted,
    });
  }

  if (order.length === 0) {
    return [{ added: 0, deleted: 0, label: '0 files', title: '' }];
  }

  if (order.length > maxVisibleFiles) {
    const totals = [...totalsByPath.values()].reduce(
      (sum, item) => ({ added: sum.added + item.added, deleted: sum.deleted + item.deleted }),
      { added: 0, deleted: 0 },
    );
    return [
      {
        ...totals,
        label: `${order.length} files`,
        title: order.join('\n'),
      },
    ];
  }

  return order.map((path) => ({
    ...totalsByPath.get(path)!,
    label: walkthroughFileName(path),
    path,
    title: path,
  }));
};

const walkthroughCoveredHunkIds = (view: WalkthroughView): ReadonlySet<string> =>
  new Set([...view.sequence, ...view.support].flatMap((item) => item.hunkIds));

const walkthroughCoveredSectionIds = (view: WalkthroughView): ReadonlySet<string> =>
  new Set(
    [...view.sequence, ...view.support].flatMap((item) =>
      item.hunks
        .map((hunk) => hunk.anchor.sectionId)
        .filter((sectionId): sectionId is string => typeof sectionId === 'string'),
    ),
  );

const walkthroughCoveredSyntheticSectionIds = (view: WalkthroughView): ReadonlySet<string> =>
  new Set(
    [...view.sequence, ...view.support].flatMap((item) =>
      item.hunks
        .filter(isSyntheticWalkthroughHunk)
        .map((hunk) => hunk.anchor.sectionId)
        .filter((sectionId): sectionId is string => typeof sectionId === 'string'),
    ),
  );

const getSectionHunkIds = (file: ChangedFile, section: DiffSection): ReadonlyArray<string> =>
  getSectionWalkthroughHunks(file, section).map((hunk: { id: string }) => hunk.id);

type UncoveredWalkthroughSection = {
  hunkIds: ReadonlyArray<string>;
  identity: string;
  section: DiffSection;
};

const getUncoveredWalkthroughSection = (
  file: ChangedFile,
  section: DiffSection,
  coveredHunkIds: ReadonlySet<string>,
  coveredSectionIds: ReadonlySet<string>,
  coveredSyntheticSectionIds: ReadonlySet<string>,
): UncoveredWalkthroughSection | null => {
  if (coveredSyntheticSectionIds.has(section.id)) {
    return null;
  }

  const hunkIds = getSectionHunkIds(file, section);
  if (hunkIds.length === 0) {
    return coveredSectionIds.has(section.id)
      ? null
      : { hunkIds: [section.id], identity: section.id, section };
  }

  const uncoveredHunkIds = hunkIds.filter((hunkId) => !coveredHunkIds.has(hunkId));
  if (uncoveredHunkIds.length === 0) {
    return null;
  }

  const identity = `${section.id}:${uncoveredHunkIds.join(',')}`;
  if (uncoveredHunkIds.length === hunkIds.length) {
    return { hunkIds: uncoveredHunkIds, identity, section };
  }

  const patch = filterPatchToHunkIds(section.patch, section.id, uncoveredHunkIds);
  return patch ? { hunkIds: uncoveredHunkIds, identity, section: { ...section, patch } } : null;
};

export const getUncoveredWalkthroughReviewIdentity = (
  file: ChangedFile,
  view: WalkthroughView,
  showWhitespace: boolean,
) => {
  const coveredHunkIds = walkthroughCoveredHunkIds(view);
  const coveredSectionIds = walkthroughCoveredSectionIds(view);
  const coveredSyntheticSectionIds = walkthroughCoveredSyntheticSectionIds(view);
  const hunkIds = getVisibleDiffSections(file, showWhitespace).flatMap(
    ({ section }) =>
      getUncoveredWalkthroughSection(
        file,
        section,
        coveredHunkIds,
        coveredSectionIds,
        coveredSyntheticSectionIds,
      )?.hunkIds ?? [],
  );
  return getWalkthroughReviewIdentity(file, hunkIds);
};

export const getUncoveredWalkthroughFiles = (
  files: ReadonlyArray<ChangedFile>,
  view: WalkthroughView,
  showWhitespace: boolean,
): ReadonlyArray<ChangedFile> => {
  const coveredHunkIds = walkthroughCoveredHunkIds(view);
  const coveredSectionIds = walkthroughCoveredSectionIds(view);
  const coveredSyntheticSectionIds = walkthroughCoveredSyntheticSectionIds(view);
  return files.flatMap((file) => {
    const uncoveredSections = getVisibleDiffSections(file, showWhitespace)
      .map(({ section }) => section)
      .map((section) =>
        getUncoveredWalkthroughSection(
          file,
          section,
          coveredHunkIds,
          coveredSectionIds,
          coveredSyntheticSectionIds,
        ),
      )
      .filter((entry): entry is UncoveredWalkthroughSection => entry != null);
    const sections = uncoveredSections.map(({ section }) => section);
    if (sections.length === 0) {
      return [];
    }
    return [
      {
        ...file,
        fingerprint: `${file.fingerprint}:walkthrough-uncovered:${uncoveredSections
          .map(({ identity }) => identity)
          .join(',')}`,
        sections,
      },
    ];
  });
};

export const getUncoveredWalkthroughFileLineItems = (
  files: ReadonlyArray<ChangedFile>,
  view: WalkthroughView,
  showWhitespace: boolean,
): ReadonlyArray<{ added: number; deleted: number; path: string }> =>
  getUncoveredWalkthroughFiles(files, view, showWhitespace).map((file) => {
    const lineCount = getDiffLineCount(file, showWhitespace);
    return {
      added: lineCount.countable ? lineCount.additions : 0,
      deleted: lineCount.countable ? lineCount.deletions : 0,
      path: file.path,
    };
  });

export const isWalkthroughCommittable = (walkthrough: NarrativeWalkthrough): boolean =>
  walkthrough.source.type === 'working-tree';

const groupSupportByReason = (
  support: ReadonlyArray<WalkthroughSupportGroup>,
): ReadonlyArray<WalkthroughSupportReason> => {
  const groups: Array<{ files: Array<WalkthroughSupportGroup>; reason: string }> = [];
  const byReason = new Map<string, { files: Array<WalkthroughSupportGroup>; reason: string }>();
  for (const item of support) {
    let group = byReason.get(item.reason);
    if (!group) {
      group = { files: [], reason: item.reason };
      byReason.set(item.reason, group);
      groups.push(group);
    }
    group.files.push(item);
  }
  return groups;
};

/** Build the walkthrough view-model with globally indexed stops. */
/** Stops a filter admits. `all` admits everything, so it never needs counting. */
const stopMatchesImportanceFilter = (
  stop: { importance: WalkthroughStop['importance'] },
  filter: WalkthroughImportanceFilter,
) => filter === 'all' || stop.importance === 'critical';

export const buildWalkthroughView = (
  walkthrough: NarrativeWalkthrough,
  importanceFilter: WalkthroughImportanceFilter = 'all',
): WalkthroughView | null => {
  if (walkthrough.chapters.length === 0) {
    return null;
  }

  const total = walkthrough.chapters.reduce((count, chapter) => count + chapter.stops.length, 0);
  const admitted = walkthrough.chapters.reduce(
    (count, chapter) =>
      count +
      chapter.stops.filter((stop) => stopMatchesImportanceFilter(stop, importanceFilter)).length,
    0,
  );
  // A filter that would leave nothing to read is not applied. Showing an empty
  // walkthrough would read as "this change has no review path", which is a
  // different and false claim.
  const filter: WalkthroughImportanceFilter = admitted === 0 ? 'all' : importanceFilter;

  const sequence: Array<WalkthroughStopView> = [];
  const chapters = walkthrough.chapters
    .map((chapter) => {
      const stops = chapter.stops
        .filter((stop) => stopMatchesImportanceFilter(stop, filter))
        .map((stop) => {
          const view = { ...stop, chapterId: chapter.id, index: sequence.length };
          sequence.push(view);
          return view;
        });
      return { ...chapter, stops };
    })
    // A chapter whose every stop is filtered out has nothing left to head.
    .filter((chapter) => chapter.stops.length > 0);

  if (sequence.length === 0) {
    return null;
  }

  return {
    chapters,
    hiddenStopCount: total - sequence.length,
    sequence,
    support: walkthrough.support,
    supportByReason: groupSupportByReason(walkthrough.support),
  };
};

/**
 * Whether every hunk a stop covers has been marked viewed.
 *
 * A stop can span several files, and one file's hunks can be split across
 * several rendered blocks, so this asks the question per hunk rather than per
 * block: the stop is finished only once nothing it points at is still pending.
 */
export const isWalkthroughStopViewed = (
  stop: { hunks: ReadonlyArray<WalkthroughHunk> },
  files: ReadonlyArray<ChangedFile>,
  viewed: Readonly<Record<string, string>>,
): boolean => {
  const hunkIdsByPath = new Map<string, Array<string>>();
  for (const hunk of stop.hunks) {
    const hunkIds = hunkIdsByPath.get(hunk.path) ?? [];
    hunkIds.push(hunk.id);
    hunkIdsByPath.set(hunk.path, hunkIds);
  }
  if (hunkIdsByPath.size === 0) {
    return false;
  }

  for (const [path, hunkIds] of hunkIdsByPath) {
    const file = files.find((candidate) => candidate.path === path);
    if (!file || !isReviewIdentityViewed(viewed, getWalkthroughReviewIdentity(file, hunkIds))) {
      return false;
    }
  }
  return true;
};

/**
 * Whether everything the walkthrough left to its Support step is marked viewed:
 * the support groups, and whatever no stop or group covers at all. It asks the
 * same question as a stop, so the Support tick means what every other tick does.
 * An empty Support step is never done, because there is nothing to have viewed.
 */
export const isWalkthroughSupportViewed = (
  files: ReadonlyArray<ChangedFile>,
  view: WalkthroughView,
  viewed: Readonly<Record<string, string>>,
  showWhitespace: boolean,
): boolean => {
  const groups = view.support.filter((group) => group.hunks.length > 0);
  const uncovered = getUncoveredWalkthroughFiles(files, view, showWhitespace);
  if (groups.length === 0 && uncovered.length === 0) {
    return false;
  }

  return (
    groups.every((group) => isWalkthroughStopViewed(group, files, viewed)) &&
    uncovered.every((entry) => {
      const file = files.find((candidate) => candidate.path === entry.path);
      return (
        file != null &&
        isReviewIdentityViewed(
          viewed,
          getUncoveredWalkthroughReviewIdentity(file, view, showWhitespace),
        )
      );
    })
  );
};

/** How many stops each filter would show, for a control that has to label itself. */
/**
 * How much of the reading each chapter carries, as a share of the whole
 * walkthrough's changed lines.
 *
 * A long walkthrough gives every chapter the same heading and the same row of
 * stops, so nothing on screen distinguishes the chapter holding half the diff
 * from the one holding a runbook. That is a question about the change rather
 * than about the agent's judgement, so it is computed from the hunks rather
 * than asked for: counting lines cannot drift between runs the way a model's
 * own estimate would.
 */
export const getWalkthroughChapterWeights = (
  walkthrough: NarrativeWalkthrough,
): ReadonlyMap<string, number> => {
  const byChapter = new Map<string, number>();
  let total = 0;
  for (const chapter of walkthrough.chapters) {
    // Counted per distinct hunk: one hunk carried by two stops of the same
    // chapter is one piece of reading, not two.
    const counted = new Set<string>();
    let lines = 0;
    for (const stop of chapter.stops) {
      for (const hunk of stop.hunks) {
        if (counted.has(hunk.id)) {
          continue;
        }
        counted.add(hunk.id);
        lines += hunk.added + hunk.deleted;
      }
    }
    byChapter.set(chapter.id, lines);
    total += lines;
  }

  if (total === 0) {
    return new Map();
  }

  // Apportioned by largest remainder rather than rounded independently, because
  // these are read side by side: two chapters of a sixteen-line change round to
  // 13% and 88% on their own, and a strip whose shares visibly do not add up
  // reads as a bug in the number rather than a fact about the change.
  const exact = [...byChapter].map(([id, lines]) => ({
    floor: Math.floor((lines / total) * 100),
    id,
    remainder: ((lines / total) * 100) % 1,
  }));
  let remaining = 100 - exact.reduce((sum, entry) => sum + entry.floor, 0);
  const byRemainder = [...exact].sort((left, right) => right.remainder - left.remainder);
  const bonus = new Set<string>();
  for (const entry of byRemainder) {
    if (remaining <= 0) {
      break;
    }
    bonus.add(entry.id);
    remaining -= 1;
  }

  const weights = new Map<string, number>();
  for (const entry of exact) {
    weights.set(entry.id, entry.floor + (bonus.has(entry.id) ? 1 : 0));
  }
  return weights;
};

export const countWalkthroughStopsByImportance = (walkthrough: NarrativeWalkthrough) => {
  const stops = walkthrough.chapters.flatMap((chapter) => chapter.stops);
  return {
    critical: stops.filter((stop) => stop.importance === 'critical').length,
    total: stops.length,
  };
};

/** The changed file + diff section a resolved hunk anchors into, if present in the diff. */
export type ResolvedWalkthroughHunkFile = {
  file: ChangedFile;
  section: DiffSection;
};

export type WalkthroughHunkRun = {
  hunks: ReadonlyArray<WalkthroughHunk>;
  key: string;
  resolved: ResolvedWalkthroughHunkFile;
};

/** Resolve one normalized hunk to its exact live `ChangedFile` and `DiffSection`. */
export const resolveWalkthroughHunkFile = (
  hunk: WalkthroughHunk,
  files: ReadonlyArray<ChangedFile>,
): ResolvedWalkthroughHunkFile | null => {
  const file = files.find((candidate) => candidate.path === hunk.path);
  if (!file) {
    return null;
  }

  const section = hunk.anchor.sectionId
    ? file.sections.find((candidate) => candidate.id === hunk.anchor.sectionId)
    : undefined;
  if (!section) {
    return null;
  }

  return { file, section };
};

const walkthroughHunkRunKey = (item: WalkthroughHunkGroup, hunks: ReadonlyArray<WalkthroughHunk>) =>
  `${item.id}:${hunks.map((hunk) => hunk.id).join(',')}`;

/** Resolve item hunks in authored order, coalescing adjacent hunks from the same file section. */
export const resolveWalkthroughHunkRuns = (
  item: WalkthroughHunkGroup,
  files: ReadonlyArray<ChangedFile>,
): ReadonlyArray<WalkthroughHunkRun> => {
  const runs: Array<WalkthroughHunkRun> = [];
  for (const hunk of item.hunks) {
    const resolved = resolveWalkthroughHunkFile(hunk, files);
    if (!resolved) {
      continue;
    }
    const previous = runs.at(-1);
    if (
      previous &&
      previous.resolved.file.path === resolved.file.path &&
      previous.resolved.section.id === resolved.section.id
    ) {
      const hunks = [...previous.hunks, hunk];
      runs[runs.length - 1] = {
        ...previous,
        hunks,
        key: walkthroughHunkRunKey(item, hunks),
      };
    } else {
      runs.push({
        hunks: [hunk],
        key: walkthroughHunkRunKey(item, [hunk]),
        resolved,
      });
    }
  }
  return runs;
};

export const getWalkthroughRunNote = (
  item: WalkthroughHunkGroup,
  run: WalkthroughHunkRun,
): string | undefined => {
  const hunkIds = new Set(run.hunks.map((hunk) => hunk.id));
  const notes = (item.notes ?? [])
    .filter((note) => hunkIds.has(note.hunkId))
    .map((note) => note.body);
  return notes.length > 0 ? notes.join(' ') : undefined;
};

const focusSignature = (section: DiffSection, hunkIds: ReadonlyArray<string>) =>
  `walkthrough:${section.id}:${hunkIds.join(',')}`;

/**
 * Return the changed-file view a walkthrough stop should render for one live diff
 * section. The patch contains exactly the provided hunk ids, in that order.
 */
export const focusChangedFileForHunks = (
  file: ChangedFile,
  section: DiffSection,
  hunks: ReadonlyArray<WalkthroughHunk>,
): ChangedFile | null => {
  const sectionHunks = hunks.filter(
    (hunk) => hunk.path === file.path && hunk.anchor.sectionId === section.id,
  );
  if (sectionHunks.length === 0) {
    return null;
  }

  const hunkIds = sectionHunks.map((hunk) => hunk.id);
  if (
    sectionHunks.some(isSyntheticWalkthroughHunk) ||
    section.binary ||
    (section.loadState != null && section.loadState !== 'ready')
  ) {
    const signature = focusSignature(section, hunkIds);
    return {
      ...file,
      fingerprint: `${file.fingerprint}:${signature}`,
      sections: [
        {
          ...section,
          summary: section.summary
            ? {
                ...section.summary,
                fingerprint: section.summary.fingerprint ?? signature,
              }
            : undefined,
        },
      ],
    };
  }

  if (section.patch.trim().length === 0) {
    return null;
  }

  const focusedPatch = filterPatchToHunkIds(section.patch, section.id, hunkIds);
  if (!focusedPatch) {
    return null;
  }

  const signature = focusSignature(section, hunkIds);

  return {
    ...file,
    fingerprint: `${file.fingerprint}:${signature}`,
    sections: [
      {
        ...section,
        newFile: undefined,
        oldFile: undefined,
        patch: focusedPatch,
        summary: {
          ...section.summary,
          fingerprint: signature,
          reason: section.summary?.reason ?? 'Focused walkthrough hunk.',
        },
      },
    ],
  };
};

/* ------------------------------------------------------------------------- *
 * Commit composer model.
 *
 * The walkthrough's stops + support items are the staged changeset. When the
 * document is committable, these helpers collapse them into one list of unique
 * changed files, grouped by the authored chapters plus a final support group.
 * Each file can carry an optional change-type tag and commit note.
 * ------------------------------------------------------------------------- */

/** One unique changed file in the commit composer, with summed line counts. */
export type CommitFile = {
  added: number;
  changeType?: WalkthroughChangeType;
  deleted: number;
  itemId: string;
  name: string;
  /** The note the generated body uses for this file. */
  note?: string;
  path: string;
};

/** A group of files in the composer — one per chapter, plus a final support group. */
export type CommitGroup = {
  files: ReadonlyArray<CommitFile>;
  icon: WalkthroughIcon;
  id: string;
  isSupport: boolean;
  title: string;
};

export type CommitModel = {
  /** Every unique file, in group order. */
  files: ReadonlyArray<CommitFile>;
  groups: ReadonlyArray<CommitGroup>;
};

export const changeTypeLabel: Record<WalkthroughChangeType, string> = {
  docs: 'Docs',
  feature: 'Feature',
  fix: 'Bug fix',
  generated: 'Generated',
  i18n: 'i18n',
  lockfile: 'Lockfile',
  refactor: 'Refactor',
  snapshot: 'Snapshot',
  test: 'Test',
};

const fileBaseName = (path: string) => path.split('/').pop() ?? path;

const countPatchLines = (patch: string): NarrativeLineCount => {
  let added = 0;
  let deleted = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      added += 1;
    } else if (line.startsWith('-')) {
      deleted += 1;
    }
  }

  return { added, deleted };
};

const getChangedFileLineCount = (file: ChangedFile): NarrativeLineCount =>
  file.sections.reduce(
    (totals, section) => {
      const count = countPatchLines(section.patch || '');
      return {
        added: totals.added + count.added,
        deleted: totals.deleted + count.deleted,
      };
    },
    { added: 0, deleted: 0 },
  );

export const buildGenericCommitModel = (changedFiles: ReadonlyArray<ChangedFile>): CommitModel => {
  const files = changedFiles.map((changedFile) => {
    const totals = getChangedFileLineCount(changedFile);
    return {
      added: totals.added,
      deleted: totals.deleted,
      itemId: `__file:${changedFile.path}`,
      name: fileBaseName(changedFile.path),
      path: changedFile.path,
    };
  });

  return {
    files,
    groups:
      files.length > 0
        ? [
            {
              files,
              icon: 'path',
              id: '__changed',
              isSupport: false,
              title: 'Changed files',
            },
          ]
        : [],
  };
};

/**
 * Collapse the walkthrough view into unique changed files. Line counts are
 * summed across every item that shares a path, and a path is placed in the first
 * group that mentions it.
 */
export const buildCommitModel = (
  view: WalkthroughView,
  changedFiles: ReadonlyArray<ChangedFile> = [],
): CommitModel => {
  const totalsByPath = new Map<string, NarrativeLineCount>();
  const addTotals = (item: WalkthroughHunkGroup) => {
    for (const hunk of item.hunks) {
      const current = totalsByPath.get(hunk.path) ?? { added: 0, deleted: 0 };
      totalsByPath.set(hunk.path, {
        added: current.added + hunk.added,
        deleted: current.deleted + hunk.deleted,
      });
    }
  };
  for (const stop of view.sequence) {
    addTotals(stop);
  }
  for (const item of view.support) {
    addTotals(item);
  }

  const seen = new Set<string>();
  const toFile = (item: WalkthroughHunkGroup, path: string): CommitFile => {
    const totals = totalsByPath.get(path) ?? { added: 0, deleted: 0 };
    return {
      added: totals.added,
      changeType: item.changeType,
      deleted: totals.deleted,
      itemId: item.id,
      name: walkthroughFileName(path),
      note: item.commitNote ?? item.summary,
      path,
    };
  };

  const files: Array<CommitFile> = [];
  const groups: Array<CommitGroup> = [];

  for (const chapter of view.chapters) {
    const chapterFiles: Array<CommitFile> = [];
    for (const stop of chapter.stops) {
      for (const path of walkthroughItemPaths(stop)) {
        if (seen.has(path)) {
          continue;
        }
        seen.add(path);
        const file = toFile(stop, path);
        chapterFiles.push(file);
        files.push(file);
      }
    }
    if (chapterFiles.length > 0) {
      groups.push({
        files: chapterFiles,
        icon: chapter.icon,
        id: chapter.id,
        isSupport: false,
        title: chapter.title,
      });
    }
  }

  const supportFiles: Array<CommitFile> = [];
  for (const item of view.support) {
    for (const path of walkthroughItemPaths(item)) {
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      const file = toFile(item, path);
      supportFiles.push(file);
      files.push(file);
    }
  }
  if (supportFiles.length > 0) {
    groups.push({
      files: supportFiles,
      icon: 'path',
      id: '__support',
      isSupport: true,
      title: 'Support',
    });
  }

  const missingFiles: Array<CommitFile> = [];
  for (const changedFile of changedFiles) {
    if (seen.has(changedFile.path)) {
      continue;
    }
    seen.add(changedFile.path);
    const totals = getChangedFileLineCount(changedFile);
    const file = {
      added: totals.added,
      deleted: totals.deleted,
      itemId: `__file:${changedFile.path}`,
      name: fileBaseName(changedFile.path),
      note: 'Not included in the generated walkthrough.',
      path: changedFile.path,
    };
    missingFiles.push(file);
    files.push(file);
  }
  if (missingFiles.length > 0) {
    groups.push({
      files: missingFiles,
      icon: 'path',
      id: '__missing',
      isSupport: true,
      title: 'Other changes',
    });
  }

  return { files, groups };
};

export const getCommitSelectionPaths = (
  view: WalkthroughView | null,
  changedFiles: ReadonlyArray<ChangedFile>,
): ReadonlyArray<string> =>
  (view ? buildCommitModel(view, changedFiles) : buildGenericCommitModel(changedFiles)).files.map(
    (file) => file.path,
  );

export const importanceLabel: Record<WalkthroughStop['importance'], string> = {
  context: 'Context',
  critical: 'Critical',
  normal: 'Review',
};
