import { describe, expect, it } from 'vitest';
import { collectDroppedFiles } from '../src/dropped-files.js';

interface MockEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?: (success: (file: File) => void) => void;
  createReader?: () => { readEntries: (success: (entries: MockEntry[]) => void) => void };
}

function fileEntry(name: string, contents: string): MockEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (success) => success(new File([contents], name)),
  };
}

function directoryEntry(name: string, entries: MockEntry[]): MockEntry {
  let read = false;
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries: (success) => {
        const batch = read ? [] : entries;
        read = true;
        success(batch);
      },
    }),
  };
}

describe('collectDroppedFiles', () => {
  it('recursively expands a dropped folder and preserves relative paths', async () => {
    const root = directoryEntry('3220586', [
      fileEntry('metadata.json', '{}'),
      directoryEntry('cover', [fileEntry('cover.webp', 'image')]),
    ]);
    const transfer = {
      items: [{ webkitGetAsEntry: () => root }],
      files: [],
    } as unknown as DataTransfer;

    const files = await collectDroppedFiles(transfer);

    expect(files.map((file) => ({
      name: file.name,
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath,
    }))).toEqual([
      { name: 'metadata.json', path: '3220586/metadata.json' },
      { name: 'cover.webp', path: '3220586/cover/cover.webp' },
    ]);
  });
});
