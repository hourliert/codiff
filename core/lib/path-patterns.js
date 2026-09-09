// @ts-check

/**
 * Gitignore-flavoured path matching, shared by the main process (which annotates
 * the walkthrough digest) and the renderer (which seeds viewed state), so a
 * reviewer's patterns cannot mean two different things in the two halves.
 *
 * Deliberately not a full glob implementation. It covers what a reviewer
 * actually writes to keep a class of file off the main path -- `**`, `*`, `?`,
 * a leading `!` to re-include, a leading `/` to anchor, and a trailing `/` for
 * a directory -- and nothing else. Brace expansion and character classes are
 * absent because a wrong guess about them is worse than an unsupported one.
 */

const REGEXP_SPECIAL = /[.+^${}()|[\]\\]/gu;

/** @param {string} value */
const escapeRegExp = (value) => value.replace(REGEXP_SPECIAL, String.raw`\$&`);

/**
 * `**` spans path separators, `*` and `?` stop at one. `**` adjacent to a
 * separator swallows it, so `**\/x` matches a bare `x` as well as `a/b/x`.
 *
 * @param {string} glob
 */
const globToRegExpSource = (glob) => {
  let source = '';
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 3;
    } else if (glob.startsWith('/**', index)) {
      source += '(?:/.*)?';
      index += 3;
    } else if (glob.startsWith('**', index)) {
      source += '.*';
      index += 2;
    } else if (glob[index] === '*') {
      source += '[^/]*';
      index += 1;
    } else if (glob[index] === '?') {
      source += '[^/]';
      index += 1;
    } else {
      source += escapeRegExp(glob[index]);
      index += 1;
    }
  }
  return source;
};

/**
 * @typedef {{negated: boolean; pattern: RegExp; source: string}} PathPattern
 */

/**
 * @param {string} rawPattern
 * @returns {PathPattern | null}
 */
const compilePathPattern = (rawPattern) => {
  const trimmed = typeof rawPattern === 'string' ? rawPattern.trim() : '';
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const negated = trimmed.startsWith('!');
  let glob = negated ? trimmed.slice(1) : trimmed;
  if (!glob) {
    return null;
  }

  // A trailing slash means "this directory", which for a file list means
  // everything beneath it.
  const directoryOnly = glob.endsWith('/');
  if (directoryOnly) {
    glob = glob.slice(0, -1);
  }

  // A leading slash anchors to the repository root. Without any slash at all the
  // pattern applies to the file name wherever it sits, which is what makes
  // `*.test.ts` behave the way everyone expects.
  const anchored = glob.startsWith('/');
  if (anchored) {
    glob = glob.slice(1);
  }
  const floating = !anchored && !glob.includes('/');

  try {
    return {
      negated,
      pattern: new RegExp(
        `^${floating ? '(?:.*/)?' : ''}${globToRegExpSource(glob)}${directoryOnly ? '/.*' : ''}$`,
        'u',
      ),
      source: trimmed,
    };
  } catch {
    // A pattern that cannot compile is ignored rather than fatal: a typo in the
    // config must not stop a review from opening.
    return null;
  }
};

/**
 * @param {ReadonlyArray<string> | undefined} patterns
 * @returns {Array<PathPattern>}
 */
const compilePathPatterns = (patterns) =>
  (Array.isArray(patterns) ? patterns : [])
    .map(compilePathPattern)
    .filter((pattern) => pattern != null);

/**
 * Later patterns win, so a `!` line can re-include something an earlier line
 * swept up -- the rule everyone already knows from `.gitignore`.
 *
 * @param {ReadonlyArray<PathPattern>} patterns
 * @param {string} path
 */
const matchesPathPatterns = (patterns, path) => {
  const normalized = String(path ?? '').replaceAll('\\', '/');
  let matched = false;
  for (const { negated, pattern } of patterns) {
    if (pattern.test(normalized)) {
      matched = !negated;
    }
  }
  return matched;
};

export { compilePathPattern, compilePathPatterns, matchesPathPatterns };
