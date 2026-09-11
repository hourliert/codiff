import type { NarrativeWalkthrough } from '../types.ts';
import { getWalkthroughChapterWeights, walkthroughItemPaths } from './narrative-walkthrough.ts';

/**
 * The walkthrough as plain text, for pasting into another agent -- a voice
 * agent the reviewer talks the change through with, say.
 *
 * It carries the structure and the prose and none of the code. An agent
 * discussing the change needs the story and where each part of it lives; the
 * code is what the reviewer already has open, and pasting it would bury the
 * story under the largest part of the text.
 */
export const formatWalkthroughForExport = (walkthrough: NarrativeWalkthrough): string => {
  const lines: Array<string> = [`# ${walkthrough.title}`, ''];
  const { source } = walkthrough;
  if (source.type === 'pull-request') {
    const name = [source.number != null ? `#${source.number}` : null, source.title]
      .filter(Boolean)
      .join(' ');
    lines.push(`Pull request: ${name || source.url} (${source.url})`, '');
  }

  if (walkthrough.thesis) {
    lines.push('## Does it do what it says', '', walkthrough.thesis, '');
  }
  lines.push('## Review focus', '', walkthrough.focus, '');

  const weights = getWalkthroughChapterWeights(walkthrough);
  let stopNumber = 0;
  for (const chapter of walkthrough.chapters) {
    const weight = weights.get(chapter.id);
    lines.push(`## ${chapter.title}${weight ? ` (${weight}% of the changed lines)` : ''}`, '');
    if (chapter.blurb) {
      lines.push(chapter.blurb, '');
    }
    for (const stop of chapter.stops) {
      stopNumber += 1;
      lines.push(`### ${stopNumber}. ${stop.title ?? 'Untitled stop'} (${stop.importance})`, '');
      const paths = walkthroughItemPaths(stop);
      if (paths.length > 0) {
        lines.push(`Files: ${paths.join(', ')}`, '');
      }
      lines.push(stop.prose, '');
    }
  }

  if (walkthrough.support.length > 0) {
    lines.push(
      '## Supporting changes',
      '',
      'Changed alongside the walkthrough without a stop of their own.',
      '',
    );
    for (const group of walkthrough.support) {
      lines.push(`- ${walkthroughItemPaths(group).join(', ')} (${group.reason})`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
};
