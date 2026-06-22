import { type DirectoryHandle, MockFileSystemAdapter } from '@brainstrike/file-system';
import { describe, expect, it } from 'vitest';
import { countExpectedWorkspaceIndexFiles } from '../workspace-index-debug-harness';

describe('countExpectedWorkspaceIndexFiles', () => {
  it('counts expected files through the app traversal and full-root policy', async () => {
    const adapter = new MockFileSystemAdapter({
      src: {
        name: 'src',
        type: 'directory',
        children: {
          'index.ts': {
            name: 'index.ts',
            type: 'file',
            content: 'export const ok = true;',
          },
        },
      },
      node_modules: {
        name: 'node_modules',
        type: 'directory',
        children: {
          pkg: {
            name: 'pkg',
            type: 'directory',
            children: {
              'index.js': {
                name: 'index.js',
                type: 'file',
                content: 'module.exports = {};',
              },
            },
          },
        },
      },
      '.git': {
        name: '.git',
        type: 'directory',
        children: {
          config: {
            name: 'config',
            type: 'file',
            content: '[core]',
          },
        },
      },
      assets: {
        name: 'assets',
        type: 'directory',
        children: {
          'logo.png': {
            name: 'logo.png',
            type: 'file',
            content: 'png',
          },
        },
      },
      docs: {
        name: 'docs',
        type: 'directory',
        children: {
          'large.md': {
            name: 'large.md',
            type: 'file',
            size: 800 * 1024,
            content: '# too large',
          },
        },
      },
    });
    const rootHandle = (await adapter.requestDirectoryAccess()) as DirectoryHandle;

    const result = await countExpectedWorkspaceIndexFiles({
      fileSystemAdapter: adapter,
      policyPreset: 'full-root',
      rootHandle,
    });

    expect(result.policyPreset).toBe('full-root');
    expect(result.rootPath).toBe('mock-root');
    expect(result.includedFiles).toContain('src/index.ts');
    expect(result.includedFiles).not.toContain('node_modules/pkg/index.js');
    expect(result.includedFiles).not.toContain('.git/config');
    expect(result.includedFiles).not.toContain('assets/logo.png');
    expect(result.includedFiles).not.toContain('docs/large.md');
    expect(result.expectedFileCount).toBe(1);
    expect(result.skippedByReason.generatedOrIgnored).toBeGreaterThan(0);
    expect(result.skippedByReason.defaultIgnore).toBeGreaterThan(0);
    expect(result.skippedByReason.entryPolicy).toBeGreaterThan(0);
  });
});
