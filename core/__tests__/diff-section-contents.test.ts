import { expect, test } from 'vite-plus/test';
import { getInMemorySectionContents } from '../lib/diff.ts';
import type { ChangedFile } from '../types.ts';

const sectionId = 'src/capture.ts:pull-request:1395';

const pullRequestFile: ChangedFile = {
  fingerprint: 'fp',
  path: 'src/capture.ts',
  sections: [
    {
      binary: false,
      id: sectionId,
      kind: 'pull-request',
      loadState: 'ready',
      newFile: { contents: 'const a = 2;\n', name: 'src/capture.ts' },
      oldFile: { contents: 'const a = 1;\n', name: 'src/capture.ts' },
      patch: '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n',
    },
  ],
  status: 'modified',
};

test('a walkthrough stop gets back the contents its pull request already loaded', () => {
  // The stop's own copy of the section has no contents, but it keeps the section
  // id, which is how the full copy in state is found again.
  expect(getInMemorySectionContents([pullRequestFile], 'src/capture.ts', sectionId)).toEqual({
    newFile: { contents: 'const a = 2;\n', name: 'src/capture.ts' },
    oldFile: { contents: 'const a = 1;\n', name: 'src/capture.ts' },
  });
});

test('an added file has no old side to expand against', () => {
  const added: ChangedFile = {
    ...pullRequestFile,
    sections: [{ ...pullRequestFile.sections[0], oldFile: undefined }],
    status: 'added',
  };

  expect(getInMemorySectionContents([added], 'src/capture.ts', sectionId)).toEqual({
    newFile: { contents: 'const a = 2;\n', name: 'src/capture.ts' },
    oldFile: null,
  });
});

test('a file that fell back to its patch has nothing to hand back', () => {
  const patchOnly: ChangedFile = {
    ...pullRequestFile,
    sections: [{ ...pullRequestFile.sections[0], newFile: undefined, oldFile: undefined }],
  };

  expect(getInMemorySectionContents([patchOnly], 'src/capture.ts', sectionId)).toBeNull();
  expect(getInMemorySectionContents([pullRequestFile], 'src/other.ts', sectionId)).toBeNull();
});
