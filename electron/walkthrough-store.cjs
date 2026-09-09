// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

/** @typedef {import('../core/types.ts').NarrativeWalkthrough} NarrativeWalkthrough */
/** @typedef {import('../core/types.ts').ReviewSource} ReviewSource */
/** @typedef {{repoRoot: string; source: ReviewSource}} WalkthroughScope */
/**
 * @typedef {{
 *   agent?: string;
 *   headSha?: string;
 *   model?: string;
 *   promptVersion?: number;
 *   walkthrough: NarrativeWalkthrough;
 *   writtenAt: number;
 * }} StoredWalkthroughRecord
 */

const MAX_STORED_WALKTHROUGH_BYTES = 8 * 1024 * 1024;

/**
 * Version 1 kept every walkthrough in one flat directory under a hash of its
 * cache key, which made an entry reachable only by recomputing that exact key.
 * Continuity needs the opposite question answered -- "what did the last round
 * of this pull request look like" -- so entries are now filed by repository and
 * review source, and carry the facts that make one round comparable to another.
 */
const STORED_WALKTHROUGH_VERSION = 2;

/** How many rounds to keep per review source. Older rounds are never read. */
const MAX_STORED_WALKTHROUGHS_PER_SOURCE = 5;

/** A review nobody has returned to in this long is not a review in progress. */
const MAX_STORED_WALKTHROUGH_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const getWalkthroughStoreDir = () => join(homedir(), '.codiff', 'walkthroughs');

/**
 * Which round is the latest has to be a total order, and two writes inside one
 * millisecond -- a forced regeneration right after the first -- would otherwise
 * tie and leave retention picking by directory order.
 */
let lastWrittenAt = 0;

const nextWrittenAt = () => {
  lastWrittenAt = Math.max(Date.now(), lastWrittenAt + 1);
  return lastWrittenAt;
};

/** @param {string} value */
const sanitize = (value) => value.replace(/[^\w.-]+/gu, '-').slice(0, 48) || 'review';

/** @param {string} value */
const digest = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Keeps the readable half of the name for the same reason the worktree store
 * does -- these directories are worth being able to identify by eye -- and
 * hashes the repository path so two clones of one repository never collide.
 *
 * @param {string} repoRoot
 */
const getRepositoryWalkthroughDir = (repoRoot) => {
  const name = repoRoot.split(/[\\/]/u).filter(Boolean).pop() || 'repository';
  return join(getWalkthroughStoreDir(), `${sanitize(name)}-${digest(repoRoot).slice(0, 8)}`);
};

/**
 * Every identifying field on a pull request source is optional, and a source
 * built from the command line carries none of them until metadata resolves, so
 * the url is the fallback that always exists.
 *
 * @param {ReviewSource} source
 */
const getSourceSegment = (source) => {
  if (source.type !== 'pull-request') {
    return 'local';
  }
  const projectPath = source.projectPath || [source.owner, source.repo].filter(Boolean).join('/');
  return projectPath && source.number != null
    ? `${sanitize(projectPath.replace('/', '-'))}-pr-${source.number}`
    : `pr-${digest(source.url).slice(0, 8)}`;
};

/** @param {WalkthroughScope} scope */
const getWalkthroughScopeDir = ({ repoRoot, source }) =>
  join(getRepositoryWalkthroughDir(repoRoot), getSourceSegment(source));

/** @param {WalkthroughScope} scope @param {string} cacheKey */
const getWalkthroughStorePath = (scope, cacheKey) =>
  join(getWalkthroughScopeDir(scope), `${digest(cacheKey)}.json`);

/** @param {unknown} value */
const isHunkGroup = (value) => {
  const group = /** @type {any} */ (value);
  return (
    group &&
    typeof group === 'object' &&
    typeof group.id === 'string' &&
    Array.isArray(group.hunkIds) &&
    group.hunkIds.every((id) => typeof id === 'string') &&
    Array.isArray(group.hunks) &&
    group.hunks.every(
      (hunk) =>
        hunk &&
        typeof hunk === 'object' &&
        typeof hunk.id === 'string' &&
        typeof hunk.path === 'string',
    )
  );
};

/** @param {unknown} value */
const isNarrativeWalkthrough = (value) => {
  const walkthrough = /** @type {any} */ (value);
  return (
    walkthrough &&
    typeof walkthrough === 'object' &&
    ['claude', 'codex', 'opencode', 'pi'].includes(walkthrough.agent) &&
    walkthrough.kind === 'narrative' &&
    walkthrough.version === 4 &&
    typeof walkthrough.focus === 'string' &&
    typeof walkthrough.generatedAt === 'string' &&
    typeof walkthrough.title === 'string' &&
    walkthrough.repo &&
    typeof walkthrough.repo === 'object' &&
    typeof walkthrough.repo.root === 'string' &&
    walkthrough.source &&
    typeof walkthrough.source === 'object' &&
    typeof walkthrough.source.type === 'string' &&
    Array.isArray(walkthrough.chapters) &&
    walkthrough.chapters.length > 0 &&
    walkthrough.chapters.every(
      (chapter) =>
        chapter &&
        typeof chapter === 'object' &&
        typeof chapter.id === 'string' &&
        typeof chapter.title === 'string' &&
        Array.isArray(chapter.stops) &&
        chapter.stops.length > 0 &&
        chapter.stops.every(isHunkGroup),
    ) &&
    Array.isArray(walkthrough.support) &&
    walkthrough.support.every(isHunkGroup)
  );
};

/**
 * @param {string} path
 * @param {string} [expectedCacheKey]
 * @returns {StoredWalkthroughRecord | null}
 */
const readRecord = (path, expectedCacheKey) => {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_STORED_WALKTHROUGH_BYTES) {
      return null;
    }
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !record ||
      typeof record !== 'object' ||
      record.version !== STORED_WALKTHROUGH_VERSION ||
      (expectedCacheKey != null && record.cacheKey !== expectedCacheKey) ||
      typeof record.writtenAt !== 'number' ||
      !isNarrativeWalkthrough(record.walkthrough)
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
};

/**
 * @param {WalkthroughScope} scope
 * @param {string} cacheKey
 * @returns {NarrativeWalkthrough | null}
 */
const readStoredWalkthrough = (scope, cacheKey) =>
  readRecord(getWalkthroughStorePath(scope, cacheKey), cacheKey)?.walkthrough ?? null;

/** @param {WalkthroughScope} scope @returns {Array<string>} */
const listScopeEntries = (scope) => {
  const directory = getWalkthroughScopeDir(scope);
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
};

/**
 * The most recent walkthrough of this review source that is not the one being
 * asked for. Entries are few -- pruning keeps them so -- which is why this
 * reads them rather than trusting an index that could disagree with the files.
 *
 * @param {WalkthroughScope} scope
 * @param {string} [excludeCacheKey]
 * @returns {StoredWalkthroughRecord | null}
 */
const readLatestStoredWalkthrough = (scope, excludeCacheKey) => {
  const excludedPath = excludeCacheKey ? getWalkthroughStorePath(scope, excludeCacheKey) : null;
  /** @type {StoredWalkthroughRecord | null} */
  let latest = null;
  for (const path of listScopeEntries(scope)) {
    if (path === excludedPath) {
      continue;
    }
    const record = readRecord(path);
    if (record && (!latest || record.writtenAt > latest.writtenAt)) {
      latest = record;
    }
  }
  return latest;
};

/**
 * Version 1 filed every walkthrough directly in the store root. Version 2 always
 * nests under a repository directory, so anything still loose there is a version
 * 1 entry -- unreadable now, and not rewritable, because the file never recorded
 * the repository path the new layout is keyed on. Deleting it costs one
 * regeneration and stops the store carrying dead weight forever.
 */
const removeLegacyStoredWalkthroughs = () => {
  try {
    for (const name of readdirSync(getWalkthroughStoreDir())) {
      if (name.endsWith('.json')) {
        rmSync(join(getWalkthroughStoreDir(), name), { force: true });
      }
    }
  } catch {
    // A store that cannot be listed has nothing to clean up.
  }
};

/**
 * Retaining a walkthrough per round rather than per diff means this directory
 * grows with every push, so it is swept on write.
 *
 * @param {WalkthroughScope} scope
 */
const pruneStoredWalkthroughs = (scope) => {
  removeLegacyStoredWalkthroughs();
  const expiredBefore = Date.now() - MAX_STORED_WALKTHROUGH_AGE_MS;
  const entries = [];
  for (const path of listScopeEntries(scope)) {
    const record = readRecord(path);
    if (!record || record.writtenAt < expiredBefore) {
      rmSync(path, { force: true });
      continue;
    }
    entries.push({ path, writtenAt: record.writtenAt });
  }
  entries.sort((left, right) => right.writtenAt - left.writtenAt);
  for (const entry of entries.slice(MAX_STORED_WALKTHROUGHS_PER_SOURCE)) {
    rmSync(entry.path, { force: true });
  }
};

/**
 * @param {WalkthroughScope} scope
 * @param {string} cacheKey
 * @param {NarrativeWalkthrough} walkthrough
 * @param {{model?: string; promptVersion?: number}} [facts]
 */
const writeStoredWalkthrough = (scope, cacheKey, walkthrough, facts) => {
  const directory = getWalkthroughScopeDir(scope);
  mkdirSync(directory, { recursive: true });
  const path = getWalkthroughStorePath(scope, cacheKey);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      JSON.stringify({
        agent: walkthrough.agent,
        cacheKey,
        // The head this round reviewed, so the next round can ask what moved.
        ...(scope.source.type === 'pull-request' && scope.source.headSha
          ? { headSha: scope.source.headSha }
          : {}),
        ...(facts?.model ? { model: facts.model } : {}),
        ...(facts?.promptVersion != null ? { promptVersion: facts.promptVersion } : {}),
        version: STORED_WALKTHROUGH_VERSION,
        walkthrough,
        writtenAt: nextWrittenAt(),
      }),
    );
    try {
      renameSync(temporaryPath, path);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (!existsSync(path) || (code !== 'EEXIST' && code !== 'EPERM')) {
        throw error;
      }
      rmSync(path, { force: true });
      renameSync(temporaryPath, path);
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  pruneStoredWalkthroughs(scope);
};

module.exports = {
  MAX_STORED_WALKTHROUGHS_PER_SOURCE,
  getWalkthroughScopeDir,
  getWalkthroughStorePath,
  pruneStoredWalkthroughs,
  readLatestStoredWalkthrough,
  readStoredWalkthrough,
  writeStoredWalkthrough,
};
