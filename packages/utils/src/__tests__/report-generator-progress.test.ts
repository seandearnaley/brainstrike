import {
  type DirectoryHandle,
  type MockFileEntry,
  MockFileSystemAdapter,
} from '@brainstrike/file-system';
import { describe, expect, it } from 'vitest';
import { generateReportFromAdapter } from '../report-generator';

function createFS(count: number) {
  const fs: Record<string, MockFileEntry> = {};
  for (let i = 0; i < count; i++) {
    fs[`file${i}.txt`] = { name: `file${i}.txt`, type: 'file', content: `${i}` };
  }
  return fs;
}

describe('generateReportFromAdapter progress', () => {
  it('calls progress callback for each entry', async () => {
    const fsData = createFS(10);
    const adapter = new MockFileSystemAdapter(fsData);
    const root = await adapter.requestDirectoryAccess();
    const progress: string[] = [];
    await generateReportFromAdapter(
      new Set(['file0.txt']),
      { 'file0.txt': '0' },
      adapter,
      root as DirectoryHandle,
      [],
      [],
      false,
      true,
      5,
      (p) => progress.push(p)
    );
    expect(progress.length).toBeGreaterThan(0);
  });
});
