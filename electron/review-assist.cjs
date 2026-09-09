// @ts-check

const { parseJSONMessage, truncate } = require('./agent-shared.cjs');

const MAX_PATCH_CHARS = 24_000;
const MAX_OTHER_FILES = 40;
const MAX_SOURCE_DESCRIPTION_CHARS = 4_000;

/**
 * @typedef {import('../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../core/types.ts').ReviewAssistantRequest} ReviewAssistantRequest
 * @typedef {import('./agent.cjs').Agent} Agent
 * @typedef {import('./agent.cjs').AgentOptions} AgentOptions
 */

const reviewAssistantSchema = {
  additionalProperties: false,
  properties: {
    reply: { type: 'string' },
    version: { const: 1, type: 'number' },
  },
  required: ['version', 'reply'],
  type: 'object',
};

/** @param {ChangedFile} file */
const getFileDigest = (file) => ({
  oldPath: file.oldPath,
  path: file.path,
  status: file.status,
  summaries: file.sections
    .map((section) => section.summary?.reason)
    .filter((summary) => typeof summary === 'string' && summary.trim()),
});

/** @param {RepositoryState} state @param {Partial<ReviewAssistantRequest> | null | undefined} request */
const buildReviewAssistantInput = (state, request) => {
  /** @type {Partial<ReviewAssistantRequest['comment']>} */
  const comment = request?.comment ?? {};
  const file = state.files.find((candidate) => candidate.path === comment.filePath);
  const section = file?.sections.find((candidate) => candidate.id === comment.sectionId);

  return {
    comment: {
      anchor: comment.anchor,
      body: typeof comment.body === 'string' ? comment.body : '',
      filePath: comment.filePath,
      lineNumber: comment.lineNumber,
      side: comment.side,
      startLineNumber: comment.startLineNumber,
      startSide: comment.startSide,
    },
    focus: file
      ? {
          file: getFileDigest(file),
          patchExcerpt: section
            ? truncate(section.patch || section.summary?.reason || '', MAX_PATCH_CHARS)
            : 'No patch context available.',
          section: section
            ? {
                binary: section.binary,
                kind: section.kind,
                loadState: section.loadState,
                summary: section.summary?.reason,
              }
            : null,
        }
      : null,
    nearbyFiles: state.files
      .filter((candidate) => candidate.path !== comment.filePath)
      .slice(0, MAX_OTHER_FILES)
      .map(getFileDigest),
    root: state.root,
    source:
      state.source.type === 'pull-request' && typeof state.source.description === 'string'
        ? {
            ...state.source,
            description: truncate(state.source.description, MAX_SOURCE_DESCRIPTION_CHARS),
          }
        : state.source,
    walkthroughNote: request?.walkthroughNote ?? null,
  };
};

/** @param {RepositoryState} state @param {Partial<ReviewAssistantRequest> | null | undefined} request @param {string} [agentLabel] */
const buildReviewAssistantPrompt = (
  state,
  request,
  agentLabel = 'Codex',
) => `You are ${agentLabel} inside Codiff.

A human reviewer wrote a rough inline review note and clicked Ask ${agentLabel}.
Reply as a concise assistant in the same inline conversation.
Use only the repository change digest below; do not inspect the repository or run shell commands.
If there is walkthrough context, use it as review orientation, not as proof.
If source.description is present, treat it as author-written PR/MR intent and orientation, not proof of behavior. The changed files and patch excerpt remain the source of truth for what changed.
Your job:
- Turn vague unease into coherent, actionable review feedback.
- If the note asks "why", explain why this change is needed based on the diff.
- If useful, suggest a clearer review comment the human could use.
- Prefer questions and concrete risks over accusations.
- The digest is evidence, so report what the change does as a conclusion drawn from it rather than as an impression of it.
- Separate what the diff proves from what it does not. Where the evidence runs out, name that specific uncertainty rather than softening the whole reply.
- Do not say the change is correct unless the diff proves it.
- Do not invent bugs, unstated requirements, or files outside the digest.
- Answer what the reviewer actually asked. This is an inline note in a review thread, not a report.
- Markdown is allowed.

Repository change digest:
${JSON.stringify(buildReviewAssistantInput(state, request), null, 2)}
`;

/** @param {unknown} value @param {string} [fallback] */
const cleanReply = (value, fallback = '') =>
  (typeof value === 'string' ? value : fallback).replace(/\n{3,}/g, '\n\n').trim();

/** @param {unknown} input @param {string} [agentLabel] */
const normalizeReviewAssistantReply = (input, agentLabel = 'Codex') => ({
  reply: cleanReply(
    input && typeof input === 'object' && 'reply' in input ? input.reply : undefined,
    `${agentLabel} could not produce a useful reply.`,
  ),
  version: 1,
});

/**
 * @param {RepositoryState} state
 * @param {ReviewAssistantRequest} request
 * @param {Agent} agent
 * @param {AgentOptions} agentOptions
 */
const readReviewAssistantReply = async (state, request, agent, agentOptions) => {
  try {
    const response = await agent.run(
      state.root,
      buildReviewAssistantPrompt(state, request, agent.label),
      reviewAssistantSchema,
      'review-assistant.json',
      `${agent.label} review reply timed out.`,
      agentOptions,
    );
    const parsed = parseJSONMessage(response);

    return {
      reply: normalizeReviewAssistantReply(parsed, agent.label).reply,
      status: 'ready',
    };
  } catch (error) {
    if (agent.isNotFoundError(error)) {
      return {
        code: agent.notFoundCode,
        reason: error instanceof Error ? error.message : String(error),
        status: 'unavailable',
      };
    }

    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  }
};

module.exports = { readReviewAssistantReply };
