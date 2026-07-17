import { type DirectoryHandle, MockFileSystemAdapter } from '@brainstrike/file-system';
import { describe, expect, it } from 'vitest';
import { countExpectedWorkspaceIndexFiles } from '../workspace-index-debug-harness';

describe('countExpectedWorkspaceIndexFiles', () => {
  it('counts expected files through the app traversal and full-root policy', async () => {
    const adapter = new MockFileSystemAdapter({
      '.git': {
        children: {
          config: {
            content: '[core]',
            name: 'config',
            type: 'file',
          },
        },
        name: '.git',
        type: 'directory',
      },
      assets: {
        children: {
          'logo.png': {
            content: 'png',
            name: 'logo.png',
            type: 'file',
          },
        },
        name: 'assets',
        type: 'directory',
      },
      docs: {
        children: {
          'large.md': {
            content: '# too large',
            name: 'large.md',
            size: 800 * 1024,
            type: 'file',
          },
        },
        name: 'docs',
        type: 'directory',
      },
      node_modules: {
        children: {
          pkg: {
            children: {
              'index.js': {
                content: 'module.exports = {};',
                name: 'index.js',
                type: 'file',
              },
            },
            name: 'pkg',
            type: 'directory',
          },
        },
        name: 'node_modules',
        type: 'directory',
      },
      src: {
        children: {
          'index.ts': {
            content: 'export const ok = true;',
            name: 'index.ts',
            type: 'file',
          },
        },
        name: 'src',
        type: 'directory',
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
